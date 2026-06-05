// Minimal service worker — caches the shell so "Add to Home Screen" works offline.
// Phase 2.0: the shell is now several small files (shell/* + modules/*) instead
// of one app.js. All are precached so the field hub launches offline.

const CACHE_NAME = 'melton-snap-v18';
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './shell/core.js',
  './shell/identity.js',
  './shell/job.js',
  './shell/sync.js',
  './shell/capture.js',
  './shell/nav.js',
  './shell/boot.js',
  './modules/photos/photos.js',
  './modules/material-request/material-request.js',
  'https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.min.js',
  'https://cdn.jsdelivr.net/npm/@azure/msal-browser@2.38.4/lib/msal-browser.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
      .catch(err => console.warn('Cache addAll failed:', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // Only clean up OUR own old caches. The /v1/ fallback page runs a separate
    // SW under the snapv1-* namespace; don't delete its cache (or it ours).
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('melton-snap-') && k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Network-first for navigation
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Network-first for dynamic config (per-job rooms.json + floorplans).
  // These can change anytime a foreman publishes; cached versions would
  // hide deletions and edits. Fall back to cache only if offline.
  if (/\/job-data\//.test(url.pathname)) {
    event.respondWith(
      fetch(req).then(res => {
        if (req.method === 'GET' && res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for everything else (shell + vendor)
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (req.method === 'GET' && res.ok && (
        req.url.startsWith(self.location.origin) ||
        req.url.startsWith('https://cdn.jsdelivr.net/')
      )) {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, clone));
      }
      return res;
    }))
  );
});
