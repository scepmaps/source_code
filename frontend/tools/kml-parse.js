/**
 * KML / KMZ parser for scepmaps overlays.
 *
 * Builds on @tmcw/togeojson for Placemarks / Tracks / MultiGeometry, then
 * normalizes styles and pulls GroundOverlays into image layers Leaflet can draw.
 */

const TOGEOJSON_URL = 'https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.8.1/+esm';
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

let toGeoJsonApi = null;
let JSZipCtor = null;

async function loadToGeoJson() {
  if (toGeoJsonApi) return toGeoJsonApi;
  const mod = await import(TOGEOJSON_URL);
  toGeoJsonApi = {
    kml: mod.kml,
    kmlWithFolders: mod.kmlWithFolders || null,
  };
  return toGeoJsonApi;
}

async function loadJSZip() {
  if (JSZipCtor) return JSZipCtor;
  const mod = await import(JSZIP_URL);
  JSZipCtor = mod.default || mod.JSZip || mod;
  return JSZipCtor;
}

function localName(node) {
  if (!node) return '';
  const raw = node.localName || node.nodeName || '';
  return String(raw).includes(':') ? String(raw).split(':').pop() : String(raw);
}

function childElements(node, name) {
  const out = [];
  if (!node?.childNodes) return out;
  const want = name ? String(name).toLowerCase() : null;
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    if (!want || localName(child).toLowerCase() === want) out.push(child);
  }
  return out;
}

function firstChild(node, name) {
  return childElements(node, name)[0] || null;
}

function textOf(node) {
  return (node?.textContent || '').trim();
}

function clamp01(n, fallback = 1) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(1, v));
}

/** KML color is aabbggrr → { color: #rrggbb, opacity } */
export function parseKmlColor(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) return null;
  if (s.length === 6) s = `ff${s}`;
  const aa = parseInt(s.slice(0, 2), 16) / 255;
  const bb = s.slice(2, 4);
  const gg = s.slice(4, 6);
  const rr = s.slice(6, 8);
  return { color: `#${rr}${gg}${bb}`.toLowerCase(), opacity: aa };
}

function prop(props, ...keys) {
  if (!props) return undefined;
  for (const key of keys) {
    if (props[key] != null && props[key] !== '') return props[key];
  }
  return undefined;
}

function geometryType(feature) {
  return feature?.geometry?.type || null;
}

function isGroundOverlayFeature(feature) {
  const props = feature?.properties || {};
  const marker = prop(props, '@geometry-type', 'geometry-type');
  return String(marker || '').toLowerCase() === 'groundoverlay';
}

function ringBounds(coords) {
  let south = Infinity;
  let west = Infinity;
  let north = -Infinity;
  let east = -Infinity;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      const lon = c[0];
      const lat = c[1];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      return;
    }
    c.forEach(walk);
  };
  walk(coords);
  if (!Number.isFinite(south) || !Number.isFinite(west)) return null;
  return { south, west, north, east };
}

function featureBounds(feature) {
  if (!feature?.geometry) return null;
  if (feature.geometry.type === 'GeometryCollection') {
    let south = Infinity;
    let west = Infinity;
    let north = -Infinity;
    let east = -Infinity;
    for (const g of feature.geometry.geometries || []) {
      const b = featureBounds({ geometry: g });
      if (!b) continue;
      south = Math.min(south, b.south);
      west = Math.min(west, b.west);
      north = Math.max(north, b.north);
      east = Math.max(east, b.east);
    }
    if (!Number.isFinite(south)) return null;
    return { south, west, north, east };
  }
  return ringBounds(feature.geometry.coordinates);
}

/**
 * Path / polygon style from GeoJSON feature props (togeojson) with fallback.
 * User overlay color/opacity used when KML has no style of its own.
 */
export function pathStyleFromFeature(feature, fallback = {}) {
  const props = feature?.properties || {};
  const fbColor = fallback.color || '#4de2ff';
  const fbOpacity = clamp01(fallback.opacity, 0.65);

  const stroke = prop(props, 'stroke', 'stroke-color', 'line') || fbColor;
  const fill = prop(props, 'fill', 'fill-color') || stroke || fbColor;
  const strokeOpacity = clamp01(
    prop(props, 'stroke-opacity', 'strokeOpacity'),
    Math.max(0.25, Math.min(1, fbOpacity + 0.2))
  );
  const fillOpacity = clamp01(
    prop(props, 'fill-opacity', 'fillOpacity'),
    Math.max(0, Math.min(0.55, fbOpacity * 0.35))
  );
  const weight = Number(prop(props, 'stroke-width', 'strokeWidth'));
  return {
    color: stroke,
    weight: Number.isFinite(weight) && weight > 0 ? Math.max(1, Math.min(12, weight)) : 2,
    opacity: strokeOpacity,
    fillColor: fill,
    fillOpacity: geometryType(feature)?.includes('Line') ? 0 : fillOpacity,
  };
}

export function pointStyleFromFeature(feature, fallback = {}) {
  const props = feature?.properties || {};
  const path = pathStyleFromFeature(feature, fallback);
  const iconHref = prop(props, 'icon', 'href', 'icon-href');
  const scale = Number(prop(props, 'icon-scale', 'iconScale', 'scale'));
  const radius = Number.isFinite(scale) && scale > 0 ? Math.max(4, Math.min(18, 6 * scale)) : 6;
  return {
    radius,
    color: path.color,
    weight: 2,
    fillColor: prop(props, 'icon-color', 'fill', 'fill-color') || path.fillColor || path.color,
    fillOpacity: clamp01(prop(props, 'icon-opacity', 'fill-opacity'), Math.max(0.35, path.fillOpacity || 0.7)),
    opacity: path.opacity,
    iconHref: typeof iconHref === 'string' && /^(https?:|data:|blob:|\/)/i.test(iconHref) ? iconHref : null,
    iconScale: Number.isFinite(scale) && scale > 0 ? scale : 1,
  };
}

function flattenFolderTree(node, bag, folderPath = []) {
  if (!node) return;
  if (node.type === 'Feature') {
    bag.push({ feature: node, folderPath: folderPath.slice() });
    return;
  }
  const name = node.meta?.name || node.name || null;
  const nextPath = name ? folderPath.concat(name) : folderPath;
  const kids = node.children || node.features || [];
  for (const child of kids) flattenFolderTree(child, bag, nextPath);
}

function extractGroundOverlaysFromDom(doc) {
  const overlays = [];
  const nodes = [];
  const walk = (el) => {
    if (!el || el.nodeType !== 1) return;
    if (localName(el).toLowerCase() === 'groundoverlay') nodes.push(el);
    for (const child of el.childNodes || []) walk(child);
  };
  walk(doc.documentElement);

  for (const node of nodes) {
    const name = textOf(firstChild(node, 'name')) || 'Ground overlay';
    const desc = textOf(firstChild(node, 'description')) || '';
    const visibility = textOf(firstChild(node, 'visibility'));
    if (visibility === '0') continue;

    let href = '';
    const icon = firstChild(node, 'icon');
    if (icon) href = textOf(firstChild(icon, 'href'));
    if (!href) href = textOf(firstChild(node, 'href'));

    const colorNode = firstChild(node, 'color');
    const parsedColor = parseKmlColor(textOf(colorNode));
    const opacity = parsedColor ? parsedColor.opacity : 1;

    const box = firstChild(node, 'latlonbox');
    const quad = firstChild(node, 'latlonquad');
    let bounds = null;
    let rotation = 0;

    if (box) {
      const north = Number(textOf(firstChild(box, 'north')));
      const south = Number(textOf(firstChild(box, 'south')));
      const east = Number(textOf(firstChild(box, 'east')));
      const west = Number(textOf(firstChild(box, 'west')));
      rotation = Number(textOf(firstChild(box, 'rotation'))) || 0;
      if ([north, south, east, west].every(Number.isFinite)) {
        bounds = { south, west, north, east };
      }
    } else if (quad) {
      // Four lon,lat pairs → bbox (Leaflet imageOverlay can't skew; use envelope)
      const coords = textOf(firstChild(quad, 'coordinates') || quad)
        .trim()
        .split(/\s+/)
        .map((pair) => pair.split(',').map(Number))
        .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (coords.length >= 4) {
        bounds = ringBounds(coords.map(([lon, lat]) => [lon, lat]));
      }
    }

    if (!bounds || !href) continue;
    overlays.push({
      name,
      description: desc,
      href,
      bounds,
      opacity,
      rotation,
    });
  }
  return overlays;
}

function emptyStats() {
  return {
    features: 0,
    points: 0,
    lines: 0,
    polygons: 0,
    collections: 0,
    groundOverlays: 0,
    folders: 0,
    skipped: 0,
  };
}

function tallyFeature(feature, stats) {
  stats.features += 1;
  const t = geometryType(feature);
  if (t === 'Point' || t === 'MultiPoint') stats.points += 1;
  else if (t === 'LineString' || t === 'MultiLineString') stats.lines += 1;
  else if (t === 'Polygon' || t === 'MultiPolygon') stats.polygons += 1;
  else if (t === 'GeometryCollection') stats.collections += 1;
  else stats.skipped += 1;
}

function countFolders(node) {
  if (!node) return 0;
  let n = node.type === 'folder' ? 1 : 0;
  for (const child of node.children || []) n += countFolders(child);
  return n;
}

/**
 * Parse KML XML text into drawable pieces.
 * @returns {{
 *   geojson: GeoJSON.FeatureCollection,
 *   groundOverlays: Array,
 *   folders: object|null,
 *   stats: object,
 * }}
 */
export async function parseKmlText(kmlText) {
  if (!kmlText || !String(kmlText).trim()) {
    throw new Error('Empty KML');
  }

  const dom = new DOMParser().parseFromString(String(kmlText), 'text/xml');
  const err = dom.querySelector('parsererror');
  if (err) throw new Error('Invalid KML XML');

  const api = await loadToGeoJson();
  const stats = emptyStats();
  let folders = null;
  let features = [];

  if (typeof api.kmlWithFolders === 'function') {
    try {
      folders = api.kmlWithFolders(dom);
      const bag = [];
      flattenFolderTree(folders, bag);
      features = bag.map((entry) => {
        const f = entry.feature;
        if (entry.folderPath?.length) {
          f.properties = { ...(f.properties || {}), _folder: entry.folderPath.join(' / ') };
        }
        return f;
      });
      stats.folders = countFolders(folders);
    } catch (_) {
      folders = null;
    }
  }

  if (!features.length) {
    const fc = api.kml(dom);
    features = Array.isArray(fc?.features) ? fc.features.slice() : [];
  }

  const groundFromDom = extractGroundOverlaysFromDom(dom);
  const groundOverlays = [];
  const geoFeatures = [];

  // Prefer DOM-extracted overlays (have reliable bounds + href). Drop matching polygon stubs.
  const overlayHrefs = new Set(groundFromDom.map((g) => g.href));
  for (const g of groundFromDom) {
    groundOverlays.push(g);
    stats.groundOverlays += 1;
  }

  for (const feature of features) {
    if (!feature || feature.type !== 'Feature') {
      stats.skipped += 1;
      continue;
    }
    if (feature.geometry == null) {
      stats.skipped += 1;
      continue;
    }

    if (isGroundOverlayFeature(feature)) {
      const props = feature.properties || {};
      const href = prop(props, 'icon', 'href');
      if (href && overlayHrefs.has(href)) {
        // already captured from DOM
        continue;
      }
      const bounds = featureBounds(feature);
      if (href && bounds) {
        groundOverlays.push({
          name: props.name || 'Ground overlay',
          description: props.description || '',
          href,
          bounds,
          opacity: clamp01(prop(props, 'fill-opacity', 'icon-opacity'), 1),
          rotation: 0,
        });
        stats.groundOverlays += 1;
        continue;
      }
    }

    tallyFeature(feature, stats);
    geoFeatures.push(feature);
  }

  return {
    geojson: { type: 'FeatureCollection', features: geoFeatures },
    groundOverlays,
    folders,
    stats,
  };
}

function guessMime(path) {
  const lower = String(path || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function normalizeZipPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

function resolveZipPath(baseDir, href) {
  const h = String(href || '').trim();
  if (!h || /^(https?:|data:|blob:)/i.test(h)) return h;
  const joined = normalizeZipPath(`${baseDir}/${h}`);
  const parts = [];
  for (const seg of joined.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Expand a KMZ ArrayBuffer into KML text with relative images inlined as data URIs.
 */
export async function kmzToKmlText(buffer) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  const kmlName =
    names.find((n) => /(^|\/)doc\.kml$/i.test(n)) ||
    names.find((n) => /\.kml$/i.test(n));
  if (!kmlName) throw new Error('KMZ has no .kml document');

  let kmlText = await zip.file(kmlName).async('string');
  const baseDir = kmlName.includes('/') ? kmlName.slice(0, kmlName.lastIndexOf('/')) : '';

  // Rewrite relative hrefs that resolve inside the archive
  kmlText = kmlText.replace(
    /(<href>\s*)([^<]+?)(\s*<\/href>)/gi,
    (match, open, href, close) => {
      const trimmed = href.trim();
      if (/^(https?:|data:|blob:)/i.test(trimmed)) return match;
      const path = resolveZipPath(baseDir, trimmed);
      const entry = zip.file(path) || zip.file(normalizeZipPath(trimmed));
      if (!entry) return match;
      // defer async rewrite — collect first
      return match;
    }
  );

  const hrefRe = /<href>\s*([^<]+?)\s*<\/href>/gi;
  const replacements = new Map();
  let m;
  while ((m = hrefRe.exec(kmlText)) !== null) {
    const trimmed = m[1].trim();
    if (/^(https?:|data:|blob:)/i.test(trimmed)) continue;
    const path = resolveZipPath(baseDir, trimmed);
    const entry = zip.file(path) || zip.file(normalizeZipPath(trimmed));
    if (!entry || replacements.has(trimmed)) continue;
    const bytes = await entry.async('base64');
    const mime = guessMime(path);
    replacements.set(trimmed, `data:${mime};base64,${bytes}`);
  }

  if (replacements.size) {
    kmlText = kmlText.replace(/<href>\s*([^<]+?)\s*<\/href>/gi, (match, href) => {
      const trimmed = href.trim();
      const dataUri = replacements.get(trimmed);
      if (!dataUri) return match;
      return `<href>${dataUri}</href>`;
    });
  }

  return kmlText;
}

/**
 * Parse a File / Blob (.kml or .kmz) into drawable pieces.
 */
export async function parseKmlFile(file) {
  if (!file) throw new Error('No file');
  const name = (file.name || '').toLowerCase();
  const isKmz =
    name.endsWith('.kmz') ||
    file.type === 'application/vnd.google-earth.kmz' ||
    file.type === 'application/zip';

  let text;
  if (isKmz) {
    const buf = await file.arrayBuffer();
    text = await kmzToKmlText(buf);
  } else {
    text = await file.text();
  }
  const parsed = await parseKmlText(text);
  return { ...parsed, kmlText: text, sourceName: file.name || 'overlay.kml' };
}

export function summarizeStats(stats) {
  if (!stats) return '';
  const parts = [];
  if (stats.points) parts.push(`${stats.points} point${stats.points === 1 ? '' : 's'}`);
  if (stats.lines) parts.push(`${stats.lines} line${stats.lines === 1 ? '' : 's'}`);
  if (stats.polygons) parts.push(`${stats.polygons} polygon${stats.polygons === 1 ? '' : 's'}`);
  if (stats.groundOverlays) {
    parts.push(`${stats.groundOverlays} image overlay${stats.groundOverlays === 1 ? '' : 's'}`);
  }
  if (stats.folders) parts.push(`${stats.folders} folder${stats.folders === 1 ? '' : 's'}`);
  return parts.join(' · ') || `${stats.features || 0} features`;
}
