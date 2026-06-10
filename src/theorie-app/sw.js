// Lichte service worker — alleen registratie, geen caching voor nu
// Houden simpel zodat updates altijd doorkomen.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
