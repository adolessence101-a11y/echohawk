// EchoHawk resident app service worker: cache the shell and the kit catalog so Kits open with no network.
const CACHE = "echohawk-v1";
const SHELL = ["/app", "/app/index.html", "/app/manifest.webmanifest", "/app/icon.svg", "/kits", "/vendor/ggwave.js"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;                          // check-ins are queued by the page, not the worker
  if (url.pathname === "/kits" || url.pathname.startsWith("/app") || url.pathname.startsWith("/vendor")) {
    e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then((m) => m || caches.match("/app/index.html"))));
  }
});
