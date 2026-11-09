'use strict';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Pass requests through to the local server. Share text, files, and API data are
// deliberately never cached by the service worker.
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin === self.location.origin && event.request.method === 'GET') {
    event.respondWith(fetch(event.request));
  }
});
