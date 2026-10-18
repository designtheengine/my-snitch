// Service worker for my snitch.
// Release rule: change CACHE_VERSION here and APP_VERSION in js/app.js on every release,
// or phones never see the update. Every file the page loads must be in FILES,
// or the app will not open offline.
var CACHE_VERSION = 'mysnitch-v28';
var FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-header-dark.png',
  './css/tokens.css',
  './css/app.css',
  './js/app.js',
  './js/db.js',
  './js/model.js',
  './js/time.js',
  './js/labels.js',
  './js/categories.js',
  './js/sleep.js',
  './js/sync.js',
  './js/errorlog.js',
  './js/safeguards.js',
  './js/ui/dom.js',
  './js/ui/home.js',
  './js/ui/entry.js',
  './js/ui/picks.js',
  './js/ui/lines.js',
  './js/ui/end.js',
  './js/ui/timepick.js',
  './js/ui/late.js',
  './js/ui/sleep-view.js',
  './js/ui/settings.js',
  './js/ui/history.js'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // cache: 'reload' skips the browser's own 10-minute memory, so the new
      // cache always holds the files that are really on the server.
      return cache.addAll(FILES.map(function (u) {
        return new Request(u, { cache: 'reload' });
      }));
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
