/* Кэш приложения: работает без сети после первого открытия.
   Firebase Authentication и внешние CDN service worker не перехватывает. */
const V = 'legendy-v16-damage-cards';
const ASSETS = [
  './',
  './index.html',
  './app.css?v=damage-card-1',
  './arsenal.js?v=damage-card-1',
  './app.js?v=damage-card-1',
  './auth.js?v=damage-card-1',
  './character-store.js?v=damage-card-1',
  './lobby-store.js?v=damage-card-1',
  './firebase-config.js?v=damage-card-1',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './assets/weapons/autogun.webp',
  './assets/weapons/bolt-pistol.webp',
  './assets/weapons/bolter.webp',
  './assets/weapons/chain-axe.webp',
  './assets/weapons/chain-hammer.webp',
  './assets/weapons/chain-sword.webp',
  './assets/weapons/fanatic-crossbow.webp',
  './assets/weapons/fanatic-daggers.webp',
  './assets/weapons/grenade-launcher.webp',
  './assets/weapons/heavy-bolter.webp',
  './assets/weapons/heavy-stubber.webp',
  './assets/weapons/heretic-claws.webp',
  './assets/weapons/improvised.webp',
  './assets/weapons/inferno-pistol.webp',
  './assets/weapons/knife.webp',
  './assets/weapons/las-pistol.webp',
  './assets/weapons/lasgun.webp',
  './assets/weapons/longlas.webp',
  './assets/weapons/meltagun.webp',
  './assets/weapons/plasma-gun.webp',
  './assets/weapons/plasma-pistol.webp',
  './assets/weapons/power-axe.webp',
  './assets/weapons/power-hammer.webp',
  './assets/weapons/power-mace.webp',
  './assets/weapons/power-sword.webp',
  './assets/weapons/stub-automatic.webp',
  './assets/weapons/stub-revolver.webp',
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

  /* Код и стили сначала берём из сети, чтобы разные версии HTML/CSS/JS не смешивались. */
  const isCoreAsset = ['script', 'style', 'worker', 'manifest'].includes(request.destination)
    || /\.(?:js|css|webmanifest)$/.test(url.pathname);

  if (isCoreAsset) {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(V).then(cache => cache.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  /* Изображения и прочие локальные файлы: кэш сразу, обновление в фоне. */
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
