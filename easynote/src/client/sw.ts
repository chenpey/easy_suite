import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { CacheFirst } from 'workbox-strategies';
import {
  SHARE_TARGET_FALLBACK_PATH,
  SHARE_TARGET_PATH,
  canReceiveShare,
  createPendingShare,
  parseShareFormData,
  savePendingShare,
} from './shareTarget';

// This file only ever runs as a service worker; the DOM lib types `self` as a window, and the Workers
// types only describe the Cloudflare flavour of the scope, so the members used here are declared.
interface ServiceWorkerScope {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
  location: Location;
  skipWaiting(): Promise<void>;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}
declare const self: ServiceWorkerScope;

// Registered before the Workbox routes below, so a system share is never answered by the navigation
// fallback. Every other request for this path gets the explanation page instead of the app shell.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== SHARE_TARGET_PATH) return;
  event.respondWith(receiveShare(event.request, url));
});

// The share is only staged; nothing is uploaded or submitted until the user's own autosave. A failed
// staging attempt therefore stays offline-capable and never forwards the received POST anywhere.
async function receiveShare(request: Request, url: URL): Promise<Response> {
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
  return new Response(null, { status: 303, headers: { Location: '/', 'Cache-Control': 'no-store' } });
}

// The precached page explains every rejected share, including while the device is offline.
async function shareFallbackResponse(): Promise<Response> {
  const page = await matchPrecache(SHARE_TARGET_FALLBACK_PATH);
  return page ?? new Response('Unable to receive share.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// PDF export needs these before the first export; keeping them out of the precache avoids downloading
// two fonts and the whole PDF renderer on every install.
const offlinePdfAssets = /^\/(?:assets\/(?:pdfmake|pdfjs|pdf\.worker)[^/]*\.(?:js|mjs)|fonts\/NotoSansSC-(?:Regular|Bold)\.otf)$/;
registerRoute(
  ({ url }) => offlinePdfAssets.test(url.pathname),
  new CacheFirst({
    cacheName: 'easynote-pdf-v1',
    plugins: [new CacheableResponsePlugin({ statuses: [0, 200] })],
  }),
);

// Client-side routes (including /shared/<token>) boot from the app shell; server endpoints never do.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), {
  denylist: [
    /^\/api\//,
    /^\/share\//,
    /^\/oauth\//,
    /^\/\.well-known\//,
    /^\/mcp/,
    /^\/share-target/,
  ],
}));
