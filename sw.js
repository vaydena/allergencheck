/* AllergenCheck – Service Worker (Offline-Shell).
 * Bei App-Änderungen VERSION erhöhen → alter Cache wird verworfen. */
var VERSION = "ac-v1-2026-09-28-2";
var CACHE = "allergencheck-" + VERSION;
/* Tesseract-Kette (versioniert, unveränderlich) dauerhaft getrennt halten. */
var OCR_CACHE = "allergencheck-ocr-v1";

var SHELL = [
  "./",
  "index.html",
  "app.html",
  "impressum.html",
  "datenschutz.html",
  "agb.html",
  "manifest.webmanifest",
  "assets/ac.css",
  "assets/ac-engine.js",
  "assets/ac-app.js",
  "assets/jspdf.umd.min.js",
  "assets/data/zutaten.json",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/icon-maskable-512.png",
  "assets/icons/apple-touch-icon.png",
  "assets/icons/favicon-32.png"
];
var CRITICAL = ["app.html", "assets/ac.css", "assets/ac-engine.js", "assets/ac-app.js", "assets/data/zutaten.json"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        var p = c.add(new Request(u, { cache: "reload" }));
        return CRITICAL.indexOf(u) !== -1 ? p : p.catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE && k !== OCR_CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url;
  try { url = new URL(req.url); } catch (x) { return; }

  // Texterkennung (jsdelivr, versionierte Pfade) cache-first → nach dem ersten Scan offline.
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(
      caches.match(req).then(function (r) {
        return r || fetch(req).then(function (resp) {
          if (resp && (resp.ok || (resp.type === "opaque" && url.pathname.indexOf("@") > 0))) {
            var cp = resp.clone();
            caches.open(OCR_CACHE).then(function (c) { c.put(req, cp); });
          }
          return resp;
        });
      })
    );
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Seiten: erst Netz (frische Rechtstexte/Preise), offline aus dem Cache.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(function (resp) {
        if (resp && resp.ok && resp.type === "basic") { var cp = resp.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); }
        return resp;
      }).catch(function () {
        return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match("app.html"); });
      })
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(function (r) {
      return r || fetch(req).then(function (resp) {
        if (resp && resp.ok && resp.type === "basic") { var cp = resp.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); }
        return resp;
      });
    })
  );
});
