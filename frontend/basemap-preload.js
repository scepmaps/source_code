import { absolutizeMapStyleUrls } from './map-style.js?v=20260811c';

/**
 * Warm the browser HTTP cache for the current map viewport across all allowed
 * base maps (except UKHO), so switching options in the Maps picker feels instant.
 */

const VECTOR_BASES = new Set(['topo', 'navigation', 'night', 'ocean']);
const CHART_OVERLAY_BASES = new Set(['shom', 'gbsouth']); // ukho intentionally excluded
const DEFAULT_CONCURRENCY = 6;

function clampZoom(z, limits) {
  const min = Number.isFinite(limits?.min) ? limits.min : 1;
  const max = Number.isFinite(limits?.max) ? limits.max : 22;
  return Math.max(min, Math.min(max, Math.round(z)));
}

/** Leaflet-style viewport tile coordinates for the current map view. */
export function getViewportTileCoords(map, zoom, tileSize = 256) {
  const z = Math.round(zoom);
  const bounds = map.getPixelBounds();
  const min = bounds.min.divideBy(tileSize).floor();
  const max = bounds.max.divideBy(tileSize).floor();
  const tiles = [];
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) {
      tiles.push({ x, y, z });
    }
  }
  return tiles;
}

function fillTileTemplate(template, { x, y, z }, subdomain = 'a') {
  return String(template)
    .replace(/\{s\}/g, subdomain)
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y));
}

function withAuthTileToken(url) {
  if (!url) return url;
  const needsAuth =
    url.includes('/tiles/arcgis/') ||
    url.includes('/tiles/shom') ||
    url.includes('/tiles/ukho') ||
    url.includes('/tiles/openaip');
  if (!needsAuth) return url;
  const token = localStorage.getItem('token') || '';
  if (!token) return url;
  if (/[?&]t=/.test(url)) {
    return url.replace(/([?&])t=[^&]*/, `$1t=${encodeURIComponent(token)}`);
  }
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 't=' + encodeURIComponent(token);
}

function authHeaders() {
  const token = localStorage.getItem('token') || '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function runPool(jobs, concurrency, signal) {
  const queue = jobs.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length) {
      if (signal?.aborted) return;
      const job = queue.shift();
      if (!job) return;
      try {
        await job();
      } catch (_) {
        // Prefetch is best-effort; ignore individual failures.
      }
    }
  });
  await Promise.all(workers);
}

function prefetchImage(url, signal) {
  return new Promise((resolve) => {
    if (!url || signal?.aborted) {
      resolve();
      return;
    }
    const img = new Image();
    const done = () => {
      img.onload = null;
      img.onerror = null;
      resolve();
    };
    img.onload = done;
    img.onerror = done;
    if (signal) {
      const onAbort = () => {
        try { img.src = ''; } catch (_) {}
        done();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    img.src = url;
  });
}

async function prefetchFetch(url, { headers, signal } = {}) {
  if (!url || signal?.aborted) return;
  try {
    await fetch(url, {
      method: 'GET',
      headers,
      mode: 'cors',
      credentials: 'same-origin',
      signal,
      cache: 'force-cache',
    });
  } catch (_) {
    // ignore
  }
}

const styleCache = new Map(); // baseKey -> style JSON (absolutized)

async function getVectorStyle(baseKey, layers, signal) {
  if (styleCache.has(baseKey)) return styleCache.get(baseKey);
  const styleUrl = layers?.[baseKey]?.styleUrl;
  if (!styleUrl) return null;
  const res = await fetch(styleUrl, {
    headers: authHeaders(),
    signal,
    cache: 'force-cache',
  });
  if (!res.ok) throw new Error(`style ${baseKey}: ${res.status}`);
  const style = absolutizeMapStyleUrls(await res.json());
  styleCache.set(baseKey, style);
  return style;
}

function collectVectorTileTemplates(style) {
  const templates = [];
  if (!style?.sources) return templates;
  for (const source of Object.values(style.sources)) {
    if (!source || typeof source !== 'object') continue;
    if (Array.isArray(source.tiles)) {
      for (const t of source.tiles) {
        if (typeof t === 'string' && (t.includes('{z}') || t.includes('{x}'))) {
          templates.push(t);
        }
      }
    }
  }
  return templates;
}

/**
 * @param {object} opts
 * @param {L.Map} opts.map
 * @param {string[]} opts.allowedBases
 * @param {object} opts.layers - LAYERS config
 * @param {(base: string) => {min:number,max:number}} opts.getZoomLimits
 * @param {string} [opts.activeBase]
 * @param {number} [opts.concurrency]
 * @param {AbortSignal} [opts.signal]
 */
export async function preloadBasemapViewportTiles(opts) {
  const {
    map,
    allowedBases = [],
    layers,
    getZoomLimits,
    activeBase = null,
    concurrency = DEFAULT_CONCURRENCY,
    signal,
  } = opts;

  if (!map || !layers || signal?.aborted) return;

  const targets = allowedBases.filter((b) => b && b !== 'ukho');
  if (!targets.length) return;

  const viewZoom = map.getZoom();
  const jobs = [];
  const vectorBases = targets.filter((b) => VECTOR_BASES.has(b));
  const rasterBases = targets.filter((b) => !VECTOR_BASES.has(b));

  // Prefetch vector styles first (shared / cached), then enqueue their viewport tiles.
  await Promise.all(
    vectorBases.map(async (base) => {
      if (signal?.aborted) return;
      try {
        const style = await getVectorStyle(base, layers, signal);
        if (!style || signal?.aborted) return;
        if (activeBase === base) return; // already visible
        const limits = typeof getZoomLimits === 'function' ? getZoomLimits(base) : { min: 1, max: 19 };
        const tiles = getViewportTileCoords(map, clampZoom(viewZoom, limits));
        for (const template of collectVectorTileTemplates(style)) {
          for (const coord of tiles) {
            const url = fillTileTemplate(template, coord);
            jobs.push(() => prefetchFetch(url, { headers: authHeaders(), signal }));
          }
        }
      } catch (_) {
        // best-effort
      }
    })
  );

  for (const base of rasterBases) {
    if (signal?.aborted) return;
    const limits = typeof getZoomLimits === 'function' ? getZoomLimits(base) : { min: 1, max: 19 };
    const tiles = getViewportTileCoords(map, clampZoom(viewZoom, limits));

    const urlsForBase = [];
    if (base === 'dark') {
      if (layers.dark?.baseUrl) urlsForBase.push(layers.dark.baseUrl);
      if (layers.dark?.labelsUrl) urlsForBase.push(layers.dark.labelsUrl);
    } else if (layers[base]?.url) {
      urlsForBase.push(layers[base].url);
    }

    // Chart overlays sit on OSM — also warm OSM underlay tiles.
    if (CHART_OVERLAY_BASES.has(base) && layers.osm?.url) {
      urlsForBase.push(layers.osm.url);
    }

    // Skip warming the already-visible base's own tiles (still warm chart overlays).
    if (activeBase === base && !CHART_OVERLAY_BASES.has(base)) continue;

    for (const template of urlsForBase) {
      for (const coord of tiles) {
        const url = withAuthTileToken(fillTileTemplate(template, coord));
        jobs.push(() => prefetchImage(url, signal));
      }
    }
  }

  await runPool(jobs, concurrency, signal);
}

export function createBasemapPreloader({
  map,
  getAllowedBases,
  layers,
  getZoomLimits,
  getActiveBase,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  let controller = null;

  return {
    warmOnMapsPickerOpen() {
      if (controller) controller.abort();
      controller = new AbortController();
      const signal = controller.signal;
      // Defer so opening the panel stays snappy.
      queueMicrotask(() => {
        preloadBasemapViewportTiles({
          map,
          allowedBases: typeof getAllowedBases === 'function' ? getAllowedBases() : [],
          layers,
          getZoomLimits,
          activeBase: typeof getActiveBase === 'function' ? getActiveBase() : null,
          concurrency,
          signal,
        }).catch(() => {});
      });
    },
    cancel() {
      if (controller) controller.abort();
      controller = null;
    },
  };
}
