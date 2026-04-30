// FILE: public/sw.js
// Purpose: Lets stale local service-worker registrations remove themselves.
// Layer: Static asset
// Exports: Service worker lifecycle handlers
// Depends on: ServiceWorkerGlobalScope APIs

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.registration.unregister());
});
