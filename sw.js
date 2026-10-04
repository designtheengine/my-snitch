// Service worker for my snitch. (Phase 0 hello-world).
// Bump CACHE_VERSION on every release so phones fetch the new files.
var CACHE_VERSION = 'mysnitch-v1';
var FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(FILES);
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.filter(function (n) { return n !== CACHE_VERSION; })
             .map(function (n) { return caches.delete(n); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

// Cache first, then the network.
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(function (hit) {
      return hit || fetch(event.request);
    })
  );
});

// The page asks for the new version to take over when the person taps the bar.
self.addEventListener('message', function (event) {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
