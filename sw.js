// Noor PWA Service Worker
// Caches the app shell for "Add to Home Screen" use
// API calls always go to network (no offline caching of patient data)

const CACHE_NAME = 'noor-shell-v1';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// ── Install: cache the shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: remove old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch strategy ──
// API calls → network only (never cache patient data)
// Everything else → cache first, fallback to network
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always network for API
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first for shell assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache successful GET responses for shell assets
        if (
          response.ok &&
          event.request.method === 'GET' &&
          SHELL_ASSETS.some(a => url.pathname === a || url.pathname === '/')
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
