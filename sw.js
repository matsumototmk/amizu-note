// オフラインでも開けるようにするための仕組み（Service Worker）
// ネットにつながっているときは最新を取りに行き、つながらないときは保存しておいたものを使う
const CACHE = 'amizu-note-v11';
const APP_FILES = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './symbols.js',
  './editor.js',
  './notepad.js',
  './backup.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const ours = url.origin === location.origin || url.hostname === 'cdnjs.cloudflare.com';
  if (!ours) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
