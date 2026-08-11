/* Scepmaps tile/style persistent cache.
 * Scope: same-origin /tiles, /api/arcgis, plus common public raster CDNs.
 * Auth query (?t=) is stripped from cache keys so JWT rotation doesn't bust the cache.
 */
const CACHE_NAME = 'scepmaps-tiles-v1';
const MAX_ENTRIES = 2500;

const CACHEABLE_HOST_SUFFIXES = [
  'tile.openstreetmap.org',
  'basemaps.cartocdn.com',
  'cdn.ons.gov.uk',
];

function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;
  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return false;
  }

  // Same-origin tile + style + MapLibre asset routes
  if (url.origin === self.location.origin) {
    const p = url.pathname;
    if (
      p.startsWith('/tiles/') ||
      p.startsWith('/api/arcgis/') ||
      p.includes('/glyphs/') ||
      p.includes('/sprite') ||
      p.endsWith('.pbf') ||
      p.endsWith('.png') ||
      p.endsWith('.jpg') ||
      p.endsWith('.jpeg') ||
      p.endsWith('.webp')
    ) {
      // Avoid caching HTML shells / app code via broad png rules under root
      if (p.startsWith('/tiles/') || p.startsWith('/api/arcgis/')) return true;
      if (p.includes('/glyphs/') || p.includes('/sprite')) return true;
      if (p.startsWith('/data/')) return true;
    }
    return false;
  }

  return CACHEABLE_HOST_SUFFIXES.some(
    (suffix) => url.hostname === suffix || url.hostname.endsWith('.' + suffix)
  );
}

function cacheKeyFor(request) {
  const url = new URL(request.url);
  // JWT / session tokens in query must not fragment the cache
  url.searchParams.delete('t');
  url.searchParams.delete('token');
  return url.toString();
}

async function trimCache(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_ENTRIES) return;
  const extra = keys.length - MAX_ENTRIES;
  for (let i = 0; i < extra; i++) {
    await cache.delete(keys[i]);
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const key = cacheKeyFor(request);
  const hit = await cache.match(key);
  if (hit) return hit;

  const response = await fetch(request);
  // Only cache successful opaque/cors tile-like responses
  if (response && (response.ok || response.type === 'opaque')) {
    try {
      await cache.put(key, response.clone());
      await trimCache(cache);
    } catch (_) {
      // Quota or opaque issues — ignore
    }
  }
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('scepmaps-tiles-') && n !== CACHE_NAME)
          .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  if (!isCacheableRequest(event.request)) return;
  event.respondWith(cacheFirst(event.request));
});
