// Vault service worker. Makes the app installable and keeps the page shell
// available when the connection drops.
// It never touches /api/ requests: sign-in, devices and transfers always go to the network.
const CACHE = "vault-shell-v2";

const SHELL = [
  "/",
  "/static/manifest.webmanifest",
  "/static/img/icon-192.png",
  "/static/img/icon-512.png",
  "/static/img/favicon.svg",
  "/static/img/logo-mark.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("vault-shell-") && key !== CACHE)
            .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/__/")) return;
  if (url.pathname === "/sw.js" || request.headers.has("range")) return;

  // Network first, so a new deploy is picked up straight away.
  // The cache is only the fallback when the network is unreachable.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then(
          (hit) => hit || (request.mode === "navigate" ? caches.match("/") : Response.error())
        )
      )
  );
});