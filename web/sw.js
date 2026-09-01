// Vibe Center service worker — offline shell + instant cold launch on iPad.
// Loopback (the owner's desktop window) stays pure network-first so an edited
// app.js shows up on one plain reload — see server.js "Never cache app
// shell/assets". Remote origins (iPad over Tailscale) get cache-first.
const CACHE = 'vibecenter-shell-v3';
const DEV = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
const NAV_TIMEOUT = 2500;
const SHELL = [
  '/', '/index.html', '/app.js', '/qr.js', '/styles.css', '/manifest.webmanifest',
  '/assets/vibe.png', '/assets/vibe-192.png', '/assets/vibe-512.png',
];

// addAll() is atomic: one timeout on a flaky iPad link and NOTHING gets cached.
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) =>
        fetch(new Request(u, { cache: 'reload' })).then((r) => (r && r.ok ? c.put(u, r) : null)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Belt-and-braces: the page also deletes the cache directly before reloading.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'PURGE_SHELL') e.waitUntil(caches.delete(CACHE));
});

const STATIC_RE = /^\/(app\.js|qr\.js|styles\.css|manifest\.webmanifest|assets\/)/;
const put = (req, res) => {
  if (res && res.ok) { const c = res.clone(); caches.open(CACHE).then((k) => k.put(req, c)).catch(() => {}); }
  return res;
};

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/agent/') || url.pathname === '/download') return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const net = fetch(req).then((res) => put('/index.html', res));
      if (DEV) { try { return await net; } catch { return (await caches.match('/index.html')) || Response.error(); } }
      const cached = await caches.match('/index.html');
      if (!cached) { try { return await net; } catch { return Response.error(); } }
      // Shell in hand: give the sleeping desktop 2.5s, then paint from cache.
      let res = null;
      try { res = await Promise.race([net, new Promise((r) => setTimeout(() => r(null), NAV_TIMEOUT))]); }
      catch { res = null; }
      e.waitUntil(net.catch(() => {}));
      return res || cached;
    })());
    return;
  }

  if (!DEV && STATIC_RE.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => put(req, res)).catch(() => hit || Response.error());
        if (hit) { e.waitUntil(net); return hit; }   // stale-while-revalidate
        return net;
      })
    );
    return;
  }

  e.respondWith(fetch(req).then((res) => put(req, res)).catch(() => caches.match(req).then((m) => m || Response.error())));
});
