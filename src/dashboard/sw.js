/* Service worker voor de IJs Super PWA.
   - API-verzoeken gaan altijd naar het netwerk (dynamisch + auth): niet cachen.
   - De app-pagina (navigatie) is network-first, met offline-fallback naar cache.
   - Statische bestanden (iconen, fonts) zijn cache-first. */
const CACHE = 'ijs-super-v3';
const SHELL = [
  '/dashboard/',
  '/dashboard/index.html',
  '/dashboard/manifest.webmanifest',
  '/dashboard/icons/icon-192.png',
  '/dashboard/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  const url = new URL(req.url);
  if (req.method !== 'GET') return;            // POST/PATCH/DELETE: met rust laten
  if (url.pathname.startsWith('/api/')) return; // API: altijd netwerk

  // Navigatie / de app-pagina: network-first zodat updates meteen zichtbaar zijn
  if (req.mode === 'navigate' || url.pathname === '/dashboard/' || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      fetch(req)
        .then((res) => { const c = res.clone(); caches.open(CACHE).then((x) => x.put('/dashboard/index.html', c)); return res; })
        .catch(() => caches.match('/dashboard/index.html'))
    );
    return;
  }

  // Statisch: cache-first, anders netwerk (en cachen)
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res.ok) { const c = res.clone(); caches.open(CACHE).then((x) => x.put(req, c)); }
      return res;
    }).catch(() => new Response('', { status: 504, statusText: 'offline' })))
  );
});
