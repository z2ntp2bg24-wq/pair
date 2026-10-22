/* Service Worker — offline app shell.
 * Code (HTML / JS / CSS / manifest / sw) is NETWORK-FIRST so a stale or half-updated cache can never pin an old
 * version; the cache is only the offline (or very slow network) fallback. Static data is cache-first.
 * Install can never fail because one URL failed. Progress data (IndexedDB / localStorage) is never touched here. */
const CACHE = "ebbinghaus-pwa-v29";
const CODE = [
  "./",
  "./index.html",
  "./app.js?v=29",
  "./styles.css?v=29",
  "./manifest.webmanifest",
];
const STATIC = [
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./data/questions.json",
  "./vendor/xlsx.full.min.js",
];
const NET_TIMEOUT_MS = 6000; // slow network → fall back to the cache instead of a blank page

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function precacheOne(cache, url) {
  try {
    const res = await withTimeout(fetch(new Request(url, { cache: "reload" })), 25000);
    if (res && res.ok) await cache.put(url, res);
  } catch (e) {
    console.warn("[sw] precache skip", url, e && e.message);
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting(); // never wait behind an old (possibly broken) worker
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(CODE.map((u) => precacheOne(cache, u)));
      await Promise.all(STATIC.map((u) => precacheOne(cache, u)));
    })().catch((e) => console.warn("[sw] install", e))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        const keys = await caches.keys();
        for (const k of keys) {
          if (k === CACHE) continue;
          // keep static copies (questions.json, Excel component, icons) the new precache may have missed
          try {
            const old = await caches.open(k);
            for (const req of await old.keys()) {
              const u = new URL(req.url);
              if (!/\.(json|png)$|\/vendor\//.test(u.pathname)) continue;
              if (!(await cache.match(req))) {
                const hit = await old.match(req);
                if (hit) await cache.put(req, hit);
              }
            }
          } catch (_) {}
          await caches.delete(k);
        }
      } catch (e) {
        console.warn("[sw] activate", e);
      }
      await self.clients.claim();
    })()
  );
});

const CODE_PATHS = /\/(index\.html|app\.js|styles\.css|manifest\.webmanifest|sw\.js)$|\/$|\/data\/decks\//;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never cache sync / API — network only
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req).catch(
        () =>
          new Response(JSON.stringify({ error: "offline" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    return;
  }
  if (url.origin !== self.location.origin) return; // third-party: browser default, never intercepted
  // admin page: never cached, never stored as the app shell
  if (/^\/admin(\.html)?\/?$/.test(url.pathname)) return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const fresh = await withTimeout(fetch(req), NET_TIMEOUT_MS);
          if (fresh && fresh.ok) cache.put("./index.html", fresh.clone());
          return fresh;
        } catch (_) {
          return (
            (await cache.match("./index.html")) ||
            (await cache.match("./")) ||
            new Response("<h1>离线且尚未缓存</h1>", { status: 503, headers: { "Content-Type": "text/html;charset=utf-8" } })
          );
        }
      })()
    );
    return;
  }

  if (CODE_PATHS.test(url.pathname)) {
    // network-first (HTTP cache bypassed), cache only as offline fallback
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const fresh = await withTimeout(fetch(new Request(req, { cache: "no-cache" })), NET_TIMEOUT_MS);
          if (fresh && fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch (e) {
          const hit = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
          if (hit) return hit;
          throw e;
        }
      })()
    );
    return;
  }

  // static data: cache-first, fill on miss
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    })()
  );
});
