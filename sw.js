const CACHE = 'portfolio-v23';
const BASE = self.registration ? self.registration.scope : '/';
const rel = p => BASE + p;
const ASSETS = [
  'manifest.json',
  'app-icon-192.png',
  'app-icon-512.png',
  'app-icon-192-maskable.png',
  'app-icon-512-maskable.png',
  'app-favicon.png',
  'chart.umd.min.js',
  'chartjs-plugin-zoom.min.js'
].map(rel);

self.addEventListener('install', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).then(() =>
      caches.open(CACHE).then(cache => cache.addAll(ASSETS).catch(() => {}))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  var url = new URL(e.request.url);
  var base_path = new URL(BASE).pathname;
  var isHTML = url.pathname === base_path || url.pathname === base_path + 'index.html' || url.pathname.endsWith('.html');
  var isDataFile = url.pathname === base_path + 'data.js';

  if (isHTML || isDataFile) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).then(res => {
        var copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request).then(c => c || new Response('Offline', { status: 503 })))
    );
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      var copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(e.request, copy));
      return res;
    }))
  );
});
