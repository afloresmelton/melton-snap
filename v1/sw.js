// FROZEN v1 fallback service worker (pre-Phase-2.0 Melton Snap).
// Scope: /melton-snap/v1/ only. Uses a DISJOINT cache namespace (snapv1-*) so
// it never deletes the root hub's melton-snap-* caches, and vice-versa.

const CACHE_NAME = 'snapv1-fallback';
const SHELL_ASSETS = [
  './',
  './index.html',
  './app.js',
  './styles.css',
  './manifest.webmanifest',
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
    // Only clean up OUR own (snapv1-*) caches — leave the root hub's alone.
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k.startsWith('snapv1-') && k !== CACHE_NAME).map(k => caches.delete(k)))
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
