"use strict";
const CACHE = "estoque-shell-v3";
const SHELL = [
  "/",
  "/static/style.css",
  "/static/app.js",
  "/static/manifest.webmanifest",
  "/static/icon.svg",
  "/static/icon-192.png",
  "/static/icon-512.png",
];
self.addEventListener("install", (e) =>
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  ),
);
self.addEventListener("activate", (e) =>
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (
    e.request.method !== "GET" ||
    u.origin !== self.location.origin ||
    u.pathname.startsWith("/api/")
  )
    return;
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/")));
    return;
  }
  if (SHELL.includes(u.pathname))
    e.respondWith(caches.match(e.request).then((c) => c || fetch(e.request)));
});
