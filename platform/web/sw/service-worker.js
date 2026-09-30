/*
 * Skeuos service worker (hand-written; emitted as /sw.js by the build).
 *
 * It precaches the app shell, the exact files this build produced, so an
 * installed app launches offline. It NEVER caches API responses: only
 * same-origin shell files and Google Fonts are handled here; every other
 * request (the Supabase REST, auth and realtime APIs, listing photos) is left
 * to the network untouched.
 */

const BUILD = '__SKEUOS_BUILD__';
const PRECACHE = '__SKEUOS_PRECACHE__';
const SHELL_CACHE = `skeuos-shell-${BUILD}`;
// v2: Zilla Slab, Public Sans and IBM Plex Mono. Older font caches are dropped on activate.
const FONT_CACHE = 'skeuos-fonts-v2';
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const SHELL_FILES = new Set(Array.isArray(PRECACHE) ? PRECACHE : []);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll([...SHELL_FILES]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                (key.startsWith('skeuos-shell-') && key !== SHELL_CACHE) || (key.startsWith('skeuos-fonts-') && key !== FONT_CACHE),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // Page loads: the network first (fresh deploys win), the cached shell offline.
    if (request.mode === 'navigate') {
      event.respondWith(shellFallback(request));
      return;
    }
    // Hashed build files, icons, the manifest: they never change within a build.
    if (SHELL_FILES.has(url.pathname)) {
      event.respondWith(cacheFirst(request));
    }
    return;
  }

  if (FONT_HOSTS.has(url.hostname)) {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
  }
  // Anything else is not ours to cache.
});

async function shellFallback(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => hit || Response.error());
  return hit || refresh;
}
