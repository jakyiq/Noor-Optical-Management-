// Noor PWA Service Worker — sw.js
// Caches the app shell for "Add to Home Screen" use.
// API calls always go to network only — patient data is never cached.
// Background Sync registration support added for LocalFirst flush.

const CACHE_NAME  = 'noor-shell-v3';
const SYNC_TAG    = 'noor-lf-flush';   // matches the tag used in localFirst.js

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/localFirst.js',   // make the LF module available offline
];

// ── Install: cache the shell ──────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: remove old caches ──────────────────────────────────────────────
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

// ── Fetch strategy ────────────────────────────────────────────────────────────
// API calls     → network only  (NEVER cache clinical data)
// Shell assets  → cache-first, network fallback
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go to network for any API route
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first for shell assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request).then(response => {
        // Only cache successful GETs for known shell assets
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

// ── Background Sync ───────────────────────────────────────────────────────────
// When the browser regains connectivity it fires the 'sync' event.
// We message all open clients so NoorLF._flush() runs in page context
// (the SW itself doesn't have access to IndexedDB opened in the page).
self.addEventListener('sync', event => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(_notifyClients({ type: 'NF_FLUSH' }));
  }
});

// ── Push notifications (placeholder) ─────────────────────────────────────────
// Uncomment and implement if you add Supabase Realtime push later.
// self.addEventListener('push', event => { ... });

// ── Helpers ───────────────────────────────────────────────────────────────────
async function _notifyClients(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  clients.forEach(c => c.postMessage(msg));
}
