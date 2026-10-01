import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The installable-app service worker, served at /sw.js (scope "/").
 *
 * Deliberately conservative: it is NOT an offline-first app shell. The
 * server stays authoritative for everything a student sees. Only GET
 * requests from this origin are ever touched, and of those only:
 *   - /_next/static/*  cache-first (content-hashed, immutable build output),
 *                      one cache per build, dropped when the build changes;
 *   - /icons/*, /favicon.ico  stale-while-revalidate (public app icons);
 *   - page navigations  network-only; if the network fails, the precached
 *                      /offline.html is shown instead. Page HTML is never
 *                      stored, so nothing personal or entitlement-related can
 *                      be replayed after logout.
 * Everything else, and all of the routes below, go straight to the network
 * with no service worker involvement at all: every API (auth, payments,
 * Razorpay webhooks, invoices, AI, answer save/submit), the whole Admin
 * panel, checkout, the Test Player and every attempt/result/review page,
 * and protected storage. POSTs (Server Actions) are never intercepted.
 *
 * Versioning: VERSION is this release's Next BUILD_ID, so every deploy
 * changes the script bytes and the browser installs a new worker. The new
 * worker WAITS — it never takes over a page on its own; the page shows
 * "New version available — Update" (components/pwa/pwa-provider.tsx),
 * which is suppressed on attempt pages so a student mid-test is never
 * reloaded.
 *
 * Kill switch: set PWA_SW_DISABLED=1 in the shared .env and reload PM2 —
 * every installed client then receives a worker that deletes its caches
 * and unregisters itself.
 */
export const dynamic = "force-dynamic";

/** Bump when the precached files (offline page, icons) change without a new build. */
const CACHE_VERSION = "1";

let buildId: string | null = null;
function getBuildId() {
  if (buildId) return buildId;
  try {
    buildId = readFileSync(path.join(process.cwd(), ".next/BUILD_ID"), "utf8").trim();
  } catch {
    buildId = "dev";
  }
  return buildId;
}

const NETWORK_ONLY_PREFIXES = ["/api", "/admin", "/student/checkout", "/student/attempt", "/storage", "/sw.js"];

function workerSource(version: string) {
  return `/* MockTestSeries service worker ${version} */
"use strict";
const VERSION = ${JSON.stringify(version)};
const PREFIX = "mts-";
const STATIC_CACHE = PREFIX + "static-" + VERSION;
const ASSET_CACHE = PREFIX + "assets-${CACHE_VERSION}";
const OFFLINE_CACHE = PREFIX + "offline-" + VERSION;
const OFFLINE_URL = "/offline.html";
const KEEP = [STATIC_CACHE, ASSET_CACHE, OFFLINE_CACHE];
const NETWORK_ONLY = ${JSON.stringify(NETWORK_ONLY_PREFIXES)};

self.addEventListener("install", (event) => {
  // No skipWaiting(): an update waits until the page asks for it.
  event.waitUntil(
    caches.open(OFFLINE_CACHE).then((cache) =>
      cache.addAll([OFFLINE_URL, "/icons/icon-192.png"].map((url) => new Request(url, { cache: "reload" })))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && !KEEP.includes(k)).map((k) => caches.delete(k))))
      // Navigation preload stays OFF: with it on, a navigation this worker
      // declines (OAuth callbacks, checkout, attempt start) could reach the
      // server twice. One request per navigation matters more than speed.
      .then(() => (self.registration.navigationPreload ? self.registration.navigationPreload.disable() : undefined))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

function isNetworkOnly(pathname) {
  return NETWORK_ONLY.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function offlineFallback() {
  return caches.open(OFFLINE_CACHE).then((cache) => cache.match(OFFLINE_URL)).then((res) => res || Response.error());
}

function cacheable(res) {
  return res && res.ok && res.type === "basic" && !/no-store|private/i.test(res.headers.get("Cache-Control") || "");
}

function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((res) => {
          if (cacheable(res)) cache.put(request, res.clone());
          return res;
        })
    )
  );
}

function staleWhileRevalidate(event, cacheName) {
  const request = event.request;
  return caches.open(cacheName).then((cache) =>
    cache.match(request).then((hit) => {
      const network = fetch(request).then((res) => {
        if (cacheable(res)) cache.put(request, res.clone());
        return res;
      });
      if (hit) {
        event.waitUntil(network.catch(() => undefined));
        return hit;
      }
      return network;
    })
  );
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isNetworkOnly(url.pathname)) return;

  if (request.mode === "navigate") {
    // Network only — page HTML is never cached. Offline page on failure.
    event.respondWith(fetch(request).catch(() => offlineFallback()));
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (url.pathname.startsWith("/icons/") || url.pathname === "/favicon.ico") {
    event.respondWith(staleWhileRevalidate(event, ASSET_CACHE));
  }
});
`;
}

const KILL_SWITCH_SOURCE = `/* MockTestSeries service worker — disabled */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("mts-")).map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
  );
});
`;

export function GET() {
  const body = process.env.PWA_SW_DISABLED === "1" ? KILL_SWITCH_SOURCE : workerSource(`${getBuildId()}-${CACHE_VERSION}`);
  return new Response(body, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Service-Worker-Allowed": "/",
      "X-Robots-Tag": "noindex",
    },
  });
}
