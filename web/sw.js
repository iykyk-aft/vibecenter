// Vibe Center service worker — makes it an installable PWA with an offline
// shell. Network-first (so the app stays fresh + the auto-update banner still
// works); falls back to cache when offline. Dynamic/auth routes are never cached.
const CACHE = 'vibecenter-shell-v2';
const SHELL = ['/', '/index.html', '/app.js', '/qr.js', '/styles.css', '/manifest.webmanifest', '/assets/vibe.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Per-user / live routes must always hit the network.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/agent/') || url.pathname === '/download') return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((m) => m || caches.match('/index.html')))
  );
});
