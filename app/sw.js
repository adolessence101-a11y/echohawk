// EchoHawk resident app service worker. Scope /app/; it also sees the page's requests for /assets, /kits, /vendor.
// Network first, cache as fallback, so the app, its kits, its last alerts and its chirp phrasebook open with no network.
const CACHE = "echohawk-v2";
const SHELL = ["/app/", "/app/manifest.webmanifest", "/app/icon.svg", "/kits", "/vendor/ggwave.js"];
const KEEP = (p) => p === "/app" || p.startsWith("/app/") || p.startsWith("/assets/") || p === "/kits" || p.startsWith("/vendor/") || p === "/phrasebook" || p === "/broadcasts/active" || p === "/languages";
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !KEEP(url.pathname)) return;   // check-ins and replies are queued by the page
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then((m) => m || (url.pathname.startsWith("/app") ? caches.match("/app/") : undefined))));
});
