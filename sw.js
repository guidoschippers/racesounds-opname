// Service worker: app-bestanden in de cache, zodat de app offline werkt.
// Verhoog VERSION bij elke wijziging; de nieuwe versie is actief na het opnieuw openen van de app.
const VERSION = 'v1.0.0';
const CACHE = `racesounds-opname-${VERSION}`;
const FILES = [
  './',
  './index.html',
  './app.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/capture-worklet.js',
  './js/db.js',
  './js/export.js',
  './js/model.js',
  './js/recorder.js',
  './js/rpm.js',
  './js/synth.js',
  './js/wav.js',
  './js/zip.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('racesounds-opname-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)),
  );
});
