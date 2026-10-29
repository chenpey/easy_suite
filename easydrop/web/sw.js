import {
  SHARE_TARGET_PATH,
  canReceiveShare,
  createPendingShare,
  parseShareFormData,
} from "./share-target.js";
import { expirePendingShare, savePendingShare } from "./share-target-store.js";

const cacheName = __EASYDROP_CACHE_NAME__;
const staticPaths = new Set(__EASYDROP_STATIC_ASSETS__);
const shareFallbackHtml = __EASYDROP_SHARE_FALLBACK_HTML__;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(cacheName).then((cache) => cache.addAll([...staticPaths])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name.startsWith("easydrop-static-") && name !== cacheName)
        .map((name) => caches.delete(name)),
    )),
    self.clients.claim(),
    // Local mailbox cleanup must never keep the new worker from activating.
    expirePendingShare().catch(() => undefined),
  ]));
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname === SHARE_TARGET_PATH) {
    // Method and mode are validated inside, so a plain GET or a scripted POST
    // also gets the explanation page instead of the Worker's JSON error.
    event.respondWith(receiveShare(event.request, url));
    return;
  }
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !staticPaths.has(url.pathname)) return;
  event.respondWith(caches.match(event.request).then(async (cached) => {
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) await (await caches.open(cacheName)).put(event.request, response.clone());
    return response;
  }).catch(() => Response.error()));
});

// The share is only staged locally; nothing is submitted or uploaded until the
// user confirms inside the app. A failed staging attempt therefore stays fully
// offline-capable and never forwards the received POST to the network.
async function receiveShare(request, url) {
  if (!canReceiveShare({
    method: request.method,
    sameOrigin: url.origin === self.location.origin,
    pathname: url.pathname,
    mode: request.mode,
  })) {
    return shareFallbackResponse();
  }
  let content = null;
  try {
    content = parseShareFormData(await request.formData());
  } catch {
    content = null;
  }
  if (!content) return shareFallbackResponse();
  try {
    await savePendingShare(createPendingShare(content, Date.now()));
  } catch {
    return shareFallbackResponse();
  }
  return new Response(null, {
    status: 303,
    headers: { "Location": "/", "Cache-Control": "no-store" },
  });
}

function shareFallbackResponse() {
  return new Response(shareFallbackHtml, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    },
  });
}
