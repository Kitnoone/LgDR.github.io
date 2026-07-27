/* Кэш приложения: работает без сети после первого открытия.
   Firebase Authentication и внешние CDN service worker не перехватывает. */
const V = 'legendy-v5-pact-fix';
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './auth.js',
  './character-store.js',
  './lobby-store.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(V)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== V).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  /* Не трогаем Firebase, Google Fonts и другие внешние запросы. */
  if (url.origin !== self.location.origin) return;

  /* Для переходов по страницам сначала просим свежую версию из сети. */
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(V).then(cache => cache.put('./index.html', copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  /* Для локальных файлов: кэш сразу, обновление в фоне. */
  event.respondWith(
    caches.match(request).then(cached => {
      const fresh = fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(V).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached || Response.error());
      return cached || fresh;
    })
  );
});
