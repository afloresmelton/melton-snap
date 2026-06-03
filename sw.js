// Minimal service worker — caches the shell so "Add to Home Screen" works offline.
// Phase 1.1: shell-only cache. Offline photo queueing comes in a later phase.

const CACHE_NAME = 'melton-snap-v13';
const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
  'https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.min.js'
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
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
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
