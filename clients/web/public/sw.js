// Deliberately no caching here — the app is always served fresh from the
// server anyway, and caching the JS bundle would risk serving a stale build
// after a deploy. This exists only so the app meets the "has a registered
// service worker with a fetch handler" PWA-installability criterion some
// browsers (notably Android Chrome) still check for.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
