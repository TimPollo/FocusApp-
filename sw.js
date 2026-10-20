const CACHE = 'focusframe-shell-v2';
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && new URL(event.request.url).pathname.match(/\.(?:html|css|js|webmanifest|png)$/)) {
      const cloned = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, cloned));
    }
    return response;
  }).catch(() => caches.match(event.request).then(resp => resp || (event.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
});
