'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Module #1 — Progress Photos (the field half of the office Progress Photos
// module). This is v1 Snap, re-expressed as a module on the field shell.
//
// It owns everything photo-specific: the room registry, the tappable
// floorplan, EXIF metadata embedding, the filename grammar, and the per-job
// map-config auto-refresh. Capture, identity, the upload outbox, and job
// context all come from the shell — see onCapture(), which now reduces to
// "pick a photo → stamp EXIF → hand to shell.sync."
// ─────────────────────────────────────────────────────────────────────────

(function (shell) {

  const U = shell.util;

  // ── Module state ────────────────────────────────────────────────────────
  const pstate = {
    rooms: [],            // unified registry: [{id, name, floor, source, polygon?}]
    room: null,           // currently selected room object or null
    tag: null,
    caption: '',
    gps: null,            // {lat, lon, acc_m} if available
    batchId: null,        // shared across one upload-batch
    mapData: null,        // parsed JSON from ?map URL
    mapBaseUrl: null,     // resolved base URL of map JSON
    activeFloorIdx: 0,
    loadedMapSavedAt: null
  };

  let fpCanvas = null;    // active FloorplanCanvas instance

  // ── Mount: wire the photos view ─────────────────────────────────────────
  function mount() {
    const cfg = shell.job.current();

    // Initial room registry from URL rooms (fallback until map data arrives)
    rebuildRoomRegistry();

    document.getElementById('roomPicker').addEventListener('change', (e) => {
      selectRoomById(e.target.value);
    });

    // Tag chips
    const chipRow = document.getElementById('tagChips');
    chipRow.innerHTML = cfg.tags.map(t =>
      `<button type="button" class="chip" data-tag="${U.escapeAttr(t)}">${U.escapeHtml(t)}</button>`
    ).join('');
    chipRow.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      chipRow.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      pstate.tag = chip.dataset.tag;
      updateShutter();
    });

    // Caption
    document.getElementById('caption').addEventListener('input', (e) => {
      pstate.caption = e.target.value;
    });

    // Shutter → shared capture → EXIF → outbox
    document.getElementById('shutterBtn').addEventListener('click', onCapture);

    // Reset map view
    document.getElementById('resetViewBtn').addEventListener('click', () => {
      if (fpCanvas) fpCanvas.resetView();
    });

    // Switch job (shell concern, button lives in the photos footer)
    document.getElementById('switchJobLink').addEventListener('click', (e) => {
      e.preventDefault();
      shell.job.switchJob();
    });

    // Refresh map — re-fetch rooms.json + floorplan without clearing config
    document.getElementById('refreshMapBtn').addEventListener('click', async (e) => {
      e.preventDefault();
      const btn = e.currentTarget;
      const orig = btn.textContent;
      btn.textContent = '⏳ Refreshing…';
      btn.disabled = true;
      try {
        if (cfg.mapUrl) {
          resetRoomSelection();
          await loadMapData(cfg.mapUrl, { bustCache: true });
          shell.log('✓ Map refreshed from network');
        } else {
          shell.log('No map URL configured for this job — nothing to refresh');
        }
      } catch (err) {
        shell.log(`✗ Refresh failed: ${err.message}`);
      } finally {
        btn.textContent = orig;
        btn.disabled = false;
      }
    });

    // Clear caption after a successful upload (room/tag kept for fast repeat)
    document.addEventListener('shell:flushed', () => {
      pstate.caption = '';
      const capEl = document.getElementById('caption');
      if (capEl) capEl.value = '';
    });

    // Background GPS (non-blocking, optional)
    requestGPS();

    // Load map if configured
    if (cfg.mapUrl) loadMapData(cfg.mapUrl);

    updateShutter();
  }

  function resetRoomSelection() {
    pstate.rooms = [];
    pstate.room = null;
    const picker = document.getElementById('roomPicker');
    if (picker) picker.value = '';
    updateShutter();
  }

  function updateShutter() {
    const ready = !!(pstate.room && pstate.tag);
    document.getElementById('shutterBtn').disabled = !ready;
    document.getElementById('hint').textContent = ready
      ? `Tap shutter — ${pstate.room.name} / ${pstate.tag}`
      : 'Pick a room and a tag, then tap the shutter.';
  }

  // ── GPS (optional) ──────────────────────────────────────────────────────
  function requestGPS() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => {
        pstate.gps = {
          lat: +pos.coords.latitude.toFixed(6),
          lon: +pos.coords.longitude.toFixed(6),
          acc_m: Math.round(pos.coords.accuracy)
        };
        shell.log(`GPS: ${pstate.gps.lat}, ${pstate.gps.lon} (±${pstate.gps.acc_m}m)`);
      },
      err => shell.log(`GPS unavailable: ${err.message}`),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  }

  // ── Capture → EXIF → outbox ─────────────────────────────────────────────
  async function onCapture() {
    try {
      // Fresh batch when the outbox is empty → new batch id. All photos taken
      // before the next upload share it so the office can group them.
      if (shell.sync.count() === 0) {
        pstate.batchId = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      }

      const jpeg = await shell.capture.pick();
      if (!jpeg) return; // user backed out

      const meta = buildMetadata();
      const tagged = await embedExif(jpeg, meta); // also assigns the J<job>__ filename

      if (!await verifyEmbed(tagged, meta)) {
        shell.log('⚠️ Local EXIF verify mismatch — queuing anyway');
      } else {
        shell.log('✓ Local EXIF verify OK');
      }

      shell.sync.enqueue({
        file: tagged,
        name: tagged.name,
        contentType: 'image/jpeg',
        thumbUrl: URL.createObjectURL(tagged),
        label: meta.room ? meta.room.name : '—'
      });
    } catch (err) {
      shell.log(`✗ Capture error: ${err.message}`);
      console.error(err);
      alert(`Capture failed: ${err.message}`);
    }
  }

  function buildMetadata() {
    const cfg = shell.job.current();
    const r = pstate.room;
    return {
      schema: 1,
      job: cfg.job,
      job_name: cfg.jobName || null,
      room: r ? {
        id: r.source === 'map' ? r.id : U.slug(r.name),
        name: r.name,
        floor: r.floor,
        source: r.source
      } : null,
      tag: pstate.tag,
      caption: pstate.caption || '',
      photographer: cfg.me,
      captured_at: new Date().toISOString(),
      batch_id: pstate.batchId,
      gps: pstate.gps,
      device: { ua: navigator.userAgent.slice(0, 120) }
    };
  }

  async function embedExif(file, meta) {
    const dataUrl = await U.fileToDataUrl(file);
    let exifObj;
    try {
      exifObj = piexif.load(dataUrl);
    } catch {
      exifObj = { '0th': {}, 'Exif': {}, 'GPS': {}, 'Interop': {}, '1st': {}, 'thumbnail': null };
    }
    exifObj.Exif = exifObj.Exif || {};
    const ASCII_PREFIX = '\x41\x53\x43\x49\x49\x00\x00\x00'; // "ASCII\0\0\0"
    exifObj.Exif[piexif.ExifIFD.UserComment] = ASCII_PREFIX + JSON.stringify(meta);
    const exifBytes = piexif.dump(exifObj);
    const newDataUrl = piexif.insert(exifBytes, dataUrl);
    return U.dataUrlToFile(newDataUrl, buildFilename());
  }

  async function verifyEmbed(file, expected) {
    try {
      const dataUrl = await U.fileToDataUrl(file);
      const exifObj = piexif.load(dataUrl);
      const uc = exifObj.Exif?.[piexif.ExifIFD.UserComment] || '';
      return uc.slice(8) === JSON.stringify(expected);
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
    return `J${shell.job.jobNo()}__${hh}${mm}${ss}__${nonce}.jpg`;
  }

  // ── Room registry + unified selection ───────────────────────────────────
  function rebuildRoomRegistry() {
    const list = [];

    // 1. Map rooms from the active floor (if a map is loaded)
    const floorIdx = pstate.mapData ? (pstate.activeFloorIdx || 0) : -1;
    const activeFloor = floorIdx >= 0 ? pstate.mapData.floors[floorIdx] : null;
    if (activeFloor) {
      for (const r of activeFloor.rooms || []) {
        list.push({ id: r.id, name: r.name, floor: activeFloor.id, source: 'map', polygon: r.polygon });
      }
    }

    // 2. Fallback rooms from JSON config
    if (pstate.mapData?.fallback_rooms) {
      for (const name of pstate.mapData.fallback_rooms) {
        list.push({ id: `fb:${U.slug(name)}`, name, floor: null, source: 'fallback' });
      }
    }

    // 3. URL-provided rooms (not duplicated by map/fallback)
    for (const name of shell.job.rooms()) {
      if (!list.find(r => r.name.toLowerCase() === name.toLowerCase())) {
        list.push({ id: `url:${U.slug(name)}`, name, floor: null, source: 'url' });
      }
    }

    pstate.rooms = list;
    populateRoomDropdown();
  }

  function populateRoomDropdown() {
    const picker = document.getElementById('roomPicker');
    const previous = picker.value;

    const mapRooms = pstate.rooms.filter(r => r.source === 'map');
    const otherRooms = pstate.rooms.filter(r => r.source !== 'map');

    let html = '<option value="">Select a room…</option>';
    if (mapRooms.length > 0) {
      html += '<optgroup label="On floorplan">';
      html += mapRooms.map(r => `<option value="${U.escapeAttr(r.id)}">${U.escapeHtml(r.name)}</option>`).join('');
      html += '</optgroup>';
    }
    if (otherRooms.length > 0) {
      html += `<optgroup label="${mapRooms.length > 0 ? 'Other locations' : 'Locations'}">`;
      html += otherRooms.map(r => `<option value="${U.escapeAttr(r.id)}">${U.escapeHtml(r.name)}</option>`).join('');
      html += '</optgroup>';
    }
    if (pstate.rooms.length === 0) {
      html = '<option value="">(No rooms configured — add map URL or &rooms= param)</option>';
      picker.disabled = true;
    } else {
      picker.disabled = false;
    }

    picker.innerHTML = html;

    if (previous && pstate.rooms.find(r => r.id === previous)) {
      picker.value = previous;
    } else if (pstate.room && pstate.rooms.find(r => r.id === pstate.room.id)) {
      picker.value = pstate.room.id;
    }
  }

  function selectRoomById(id) {
    const room = id ? (pstate.rooms.find(r => r.id === id) || null) : null;
    pstate.room = room;

    const picker = document.getElementById('roomPicker');
    if (picker.value !== (id || '')) picker.value = id || '';

    if (fpCanvas) {
      if (room && room.source === 'map') fpCanvas.selectRoom(room.id, { silent: true });
      else fpCanvas.selectRoom(null, { silent: true });
    }

    updateShutter();
  }

  // ── Floorplan / map ─────────────────────────────────────────────────────

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
    shell.log(`Fetching map config from ${mapUrl}${opts.bustCache ? ' (cache-busted)' : ''}`);

    try {
      const resolved = new URL(mapUrl, location.href);
      const fetchOpts = opts.bustCache ? { cache: 'reload' } : {};
      const res = await fetch(resolved.href, fetchOpts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      shell.log(`✓ Map config loaded — ${data.floors?.length || 0} floor(s)`);

      if (!data.floors || data.floors.length === 0) {
        statusEl.textContent = `No floors in map config.`;
        return;
      }

      pstate.mapData = data;
      pstate.mapBaseUrl = resolved.href;
      pstate.activeFloorIdx = 0;
      pstate.loadedMapSavedAt = data.saved_at || null;

      rebuildRoomRegistry();
      initFloorplanCanvas(0);

      if (data.floors.length > 1) {
        const tabsEl = document.getElementById('floorTabs');
        tabsEl.hidden = false;
        tabsEl.innerHTML = data.floors.map((f, i) =>
          `<button type="button" class="chip${i === 0 ? ' active' : ''}" data-floor-idx="${i}">${U.escapeHtml(f.name)}</button>`
        ).join('');
        tabsEl.addEventListener('click', (e) => {
          const btn = e.target.closest('.chip');
          if (!btn) return;
          const idx = parseInt(btn.dataset.floorIdx, 10);
          if (Number.isNaN(idx) || idx === pstate.activeFloorIdx) return;
          switchFloor(idx);
          tabsEl.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === btn));
        });
      }
    } catch (err) {
      statusEl.textContent = `Map load failed: ${err.message}`;
      shell.log(`✗ Map load failed: ${err.message}`);
    }
  }

  function initFloorplanCanvas(floorIdx) {
    const floor = pstate.mapData.floors[floorIdx];
    const imageUrl = new URL(floor.image, pstate.mapBaseUrl).href;
    const canvasEl = document.getElementById('floorplanCanvas');
    const statusEl = document.getElementById('mapStatus');
    const readyText = `${floor.name} — tap a room`;

    fpCanvas = new FloorplanCanvas(canvasEl, imageUrl, {
      floor,
      onReady: () => {
        statusEl.textContent = readyText;
        if (pstate.room && pstate.room.floor === floor.id) {
          fpCanvas.selectRoom(pstate.room.id, { silent: true });
        }
      },
      onError: (err) => {
        statusEl.textContent = `Couldn't load floorplan image: ${err.message}`;
      },
      onRoomSelected: (room) => {
        if (room) {
          statusEl.innerHTML = `Selected: <strong>${U.escapeHtml(room.name)}</strong>`;
          shell.log(`Map tap → room ${room.id} (${room.name})`);
          selectRoomById(room.id);
        } else {
          statusEl.textContent = readyText;
        }
      }
    });
  }

  function switchFloor(floorIdx) {
    pstate.activeFloorIdx = floorIdx;
    rebuildRoomRegistry();
    initFloorplanCanvas(floorIdx);
    shell.log(`Switched to floor ${floorIdx}: ${pstate.mapData.floors[floorIdx].name}`);
  }

  class FloorplanCanvas {
    constructor(canvas, imgUrl, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts;
      this.transform = { x: 0, y: 0, scale: 1 };
      this.pointers = new Map();
      this.pinchStart = null;
      this.tapStart = null;
      this.rooms = opts.floor?.rooms || [];
      this.selectedRoomId = null;
      this.onRoomSelected = opts.onRoomSelected || (() => {});
      this.loaded = false;
      this.dpr = window.devicePixelRatio || 1;

      this.image = new Image();
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

    resetView() { this.fit(); this.render(); }

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
      return { x: (clientX - rect.left) * this.dpr, y: (clientY - rect.top) * this.dpr };
    }

    onPointerDown(e) {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      const p = this._clientToCanvas(e.clientX, e.clientY);
      this.pointers.set(e.pointerId, p);

      if (this.pointers.size === 1) {
        this.tapStart = { x: p.x, y: p.y, t: Date.now() };
      } else {
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

      if (this.tapStart) {
        const dx = next.x - this.tapStart.x;
        const dy = next.y - this.tapStart.y;
        const moveThreshold = (10 * this.dpr) ** 2;
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

  // ── Config auto-refresh (map rooms.json) ────────────────────────────────
  // Called by the shell tick (visibility/focus/interval). Silently swaps in a
  // newer published config; defers behind the banner if items are pending.
  async function onTick() {
    const cfg = shell.job.current();
    if (!cfg.mapUrl) return;
    if (!pstate.loadedMapSavedAt) return; // nothing to compare yet
    try {
      const url = new URL(cfg.mapUrl, location.href);
      const bustedUrl = url.href + (url.search ? '&' : '?') + '_t=' + Date.now();
      const res = await fetch(bustedUrl, { cache: 'reload' });
      if (!res.ok) return;
      const fresh = await res.json();
      if (!fresh.saved_at) return;
      if (fresh.saved_at === pstate.loadedMapSavedAt) return; // up-to-date

      shell.log(`New config detected: ${pstate.loadedMapSavedAt} → ${fresh.saved_at}`);

      // Don't disrupt pending work — let them finish, then tap the banner.
      if (shell.sync.count() > 0) {
        shell.ui.banner.show({
          key: 'config:' + fresh.saved_at,
          message: 'Updated map — upload your items first',
          onAction: async () => {
            resetRoomSelection();
            try { await loadMapData(cfg.mapUrl, { bustCache: true }); }
            catch (err) { shell.log(`Refresh failed: ${err.message}`); }
          }
        });
        return;
      }

      shell.log('Auto-refreshing map (nothing pending)');
      resetRoomSelection();
      await loadMapData(cfg.mapUrl, { bustCache: true });
    } catch (err) {
      // Network issue — silent
    }
  }

  // ── Register ────────────────────────────────────────────────────────────
  shell.nav.register({
    id: 'photos',
    name: 'Photos',
    icon: '📸',
    rootId: 'module-photos',
    mount,
    onTick
  });

})(window.shell);
