const cachePrefix = `kamamiku-shell:${self.registration.scope}:`;
const cacheName = `${cachePrefix}v2`;
const shellPaths = [
  "./", "./styles.css", "./app.js", "./catalog.js", "./manifest.webmanifest",
  "./assets/kamamiku-cover.webp", "./assets/app-icon-180.png", "./assets/app-icon-192.png",
  "./assets/app-icon-512.png", "./assets/app-icon-maskable.png",
];
const shellUrls = new Set(shellPaths.map(path => new URL(path, self.registration.scope).href));
const homeUrl = new URL(self.registration.scope);
const indexPath = new URL("index.html", homeUrl).pathname;

self.addEventListener("install", event => {
  const assets = [...shellUrls].map(url => new Request(url, { cache: "reload" }));
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(assets)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const oldCaches = (await caches.keys()).filter(name => name.startsWith(cachePrefix) && name !== cacheName);
    await Promise.all(oldCaches.map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET" || request.headers.has("range")) return;

  const url = new URL(request.url);
  const isHome = request.mode === "navigate" && url.origin === homeUrl.origin &&
    (url.pathname === homeUrl.pathname || url.pathname === indexPath);
  const cacheUrl = isHome ? homeUrl.href : request.url;
  if (!shellUrls.has(cacheUrl)) return;

  // Keep the app available offline while streams go directly to their source.
  event.respondWith((async () => {
    const cache = await caches.open(cacheName).catch(() => null);
    const saved = await cache?.match(cacheUrl).catch(() => undefined);
    if (saved) return saved;
    const response = await fetch(isHome ? homeUrl.href : request);
    if (cache && response.ok && !response.redirected) {
      await cache.put(cacheUrl, response.clone()).catch(() => {});
    }
    return response;
  })());
});
