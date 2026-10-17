/* ---------------------------------------------------------------------------
 * The factory phone's service worker: what lets the app OPEN with no network.
 *
 * Scope is /factory only. It keeps three things:
 *   - the /factory page itself, network first: fresh whenever there is a
 *     signal, yesterday's copy when there is none;
 *   - the page's scripts and styles (/_next/static), cache first: their names
 *     carry a content hash, so a cached one is never stale — it is exactly
 *     the file the cached page asks for, which is what keeps an old page
 *     working after a deploy;
 *   - fonts, so Hindi and Marathi still draw.
 * It never caches /api: the floor's data lives in the page's own storage, and
 * a send must reach the server or be honestly kept back.
 *
 * Bump VERSION to drop every older cache on the next visit.
 * ------------------------------------------------------------------------- */
const VERSION = "v1";
const PAGES = "factory-pages-" + VERSION;
const STATIC = "factory-static-" + VERSION;
const FONTS = "factory-fonts-" + VERSION;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([PAGES, STATIC, FONTS]);
      for (const k of await caches.keys()) if (k.startsWith("factory-") && !keep.has(k)) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

/* A shared phone: signing out takes the last person's page with it. */
self.addEventListener("message", (event) => {
  if (event.data === "forget-pages") event.waitUntil(caches.delete(PAGES));
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

const OFFLINE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Factory - MahekOne</title></head><body style="margin:0;font-family:system-ui,sans-serif;background:#F7F8FA;color:#1A1E28;display:flex;align-items:center;justify-content:center;min-height:100vh">
<div style="max-width:320px;padding:24px;text-align:center"><div style="font-size:22px;font-weight:700">No network</div>
<div style="font-size:16px;line-height:23px;color:#3D4453;margin-top:8px">Open the Factory app once with the network on, then it works without it.</div>
<button onclick="location.reload()" style="margin-top:20px;height:56px;width:100%;border:none;border-radius:16px;background:#6835FB;color:#fff;font-size:18px;font-weight:700">Try again</button></div></body></html>`;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;

  if (req.mode === "navigate" && url.origin === location.origin && url.pathname.startsWith("/factory")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PAGES);
        try {
          const res = await withTimeout(fetch(req), 6000);
          if (res.ok && url.pathname === "/factory") await cache.put("/factory", res.clone());
          return res;
        } catch {
          return (await cache.match(url.pathname === "/factory" ? "/factory" : req)) ?? (await cache.match("/factory")) ?? new Response(OFFLINE_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
      })(),
    );
    return;
  }

  if (url.origin === location.origin && url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC);
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
        return res;
      })(),
    );
    return;
  }

  if (url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(FONTS);
        const hit = await cache.match(req);
        const fresh = fetch(req)
          .then((res) => {
            if (res.ok || res.type === "opaque") cache.put(req, res.clone());
            return res;
          })
          .catch(() => hit);
        return hit ?? fresh;
      })(),
    );
  }
});
