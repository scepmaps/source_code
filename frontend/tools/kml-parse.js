/**
 * KML / KMZ parser for scepmaps overlays.
 *
 * Builds GeoJSON for Leaflet, plus a full inventory of operational metadata
 * that is easy to miss in Google Earth alone: schemas, ExtendedData (paths /
 * layers), LookAt cameras, altitudes, visibility, folder hierarchy, and
 * derived bounds / area / length metrics.
 */

const TOGEOJSON_URL = 'https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.8.1/+esm';
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

const EARTH_RADIUS_M = 6371008.8;

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

function toNum(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toBoolFlag(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (s === '1' || s.toLowerCase() === 'true') return true;
  if (s === '0' || s.toLowerCase() === 'false') return false;
  const n = Number(s);
  if (Number.isFinite(n)) return n !== 0;
  return null;
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
    if (!NumberIsFiniteSafe(south)) return null;
    return { south, west, north, east };
  }
  return ringBounds(feature.geometry.coordinates);
}

function NumberIsFiniteSafe(n) {
  return Number.isFinite(n);
}

function mergeBounds(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    south: Math.min(a.south, b.south),
    west: Math.min(a.west, b.west),
    north: Math.max(a.north, b.north),
    east: Math.max(a.east, b.east),
  };
}

function round(n, digits = 4) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function haversineMeters(lon1, lat1, lon2, lat2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

function lineLengthMeters(coords) {
  if (!Array.isArray(coords) || coords.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < coords.length; i += 1) {
    const a = coords[i - 1];
    const b = coords[i];
    if (!a || !b) continue;
    sum += haversineMeters(a[0], a[1], b[0], b[1]);
  }
  return sum;
}

/** Spherical excess polygon area (m²). Ring may be open or closed. */
function ringAreaMeters2(coords) {
  if (!Array.isArray(coords) || coords.length < 3) return 0;
  const ring = coords.slice();
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  if (ring.length < 4) return 0;

  const toRad = Math.PI / 180;
  let total = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const lon1 = ring[i][0] * toRad;
    const lon2 = ring[i + 1][0] * toRad;
    const lat1 = ring[i][1] * toRad;
    const lat2 = ring[i + 1][1] * toRad;
    total += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

function uniqueSorted(nums) {
  const set = new Set();
  for (const n of nums) {
    if (Number.isFinite(n)) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

function collectAltitudes(coords, bag = []) {
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      if (c.length >= 3 && Number.isFinite(c[2])) bag.push(c[2]);
      return;
    }
    c.forEach(walk);
  };
  walk(coords);
  return bag;
}

function collectGeomAltitudes(geom, bag = []) {
  if (!geom) return bag;
  if (geom.type === 'GeometryCollection') {
    for (const g of geom.geometries || []) collectGeomAltitudes(g, bag);
    return bag;
  }
  collectAltitudes(geom.coordinates, bag);
  return bag;
}

function countVertices(coords) {
  let n = 0;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number' && typeof c[1] === 'number') {
      n += 1;
      return;
    }
    c.forEach(walk);
  };
  walk(coords);
  return n;
}

function stripClosingDuplicate(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return ring || [];
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (a[0] === b[0] && a[1] === b[1] && (a[2] ?? null) === (b[2] ?? null)) {
    return ring.slice(0, -1);
  }
  return ring;
}

/**
 * Path / polygon style from GeoJSON feature props (togeojson / inventory) with fallback.
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
    schemas: 0,
    styles: 0,
    styleMaps: 0,
    lookAts: 0,
    withExtendedData: 0,
    withAltitude: 0,
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

// ---- Full inventory extraction ------------------------------------------------

function parseCoordinateTuples(text) {
  if (!text) return [];
  const coords = [];
  for (const token of String(text).trim().split(/\s+/)) {
    if (!token) continue;
    const parts = token.split(',');
    if (parts.length < 2) continue;
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const alt = parts.length >= 3 ? Number(parts[2]) : null;
    if (Number.isFinite(alt)) coords.push([lon, lat, alt]);
    else coords.push([lon, lat]);
  }
  return coords;
}

function parseLookAt(node) {
  if (!node) return null;
  const look = firstChild(node, 'LookAt') || firstChild(node, 'Camera');
  if (!look) return null;
  const altitudeMode =
    textOf(firstChild(look, 'altitudeMode')) ||
    textOf(firstChild(look, 'gx:altitudeMode')) ||
    (() => {
      for (const child of childElements(look)) {
        if (localName(child).toLowerCase() === 'altitudemode') return textOf(child);
      }
      return null;
    })();
  const out = {
    longitude: toNum(textOf(firstChild(look, 'longitude'))),
    latitude: toNum(textOf(firstChild(look, 'latitude'))),
    altitude: toNum(textOf(firstChild(look, 'altitude'))),
    heading: toNum(textOf(firstChild(look, 'heading'))),
    tilt: toNum(textOf(firstChild(look, 'tilt'))),
    range: toNum(textOf(firstChild(look, 'range'))),
    altitudeMode: altitudeMode || null,
    kind: localName(look),
  };
  if (out.longitude == null && out.latitude == null) return null;
  return out;
}

function parseExtendedData(pm) {
  const ed = firstChild(pm, 'ExtendedData');
  if (!ed) return null;
  const out = {
    schemaUrl: null,
    data: {},
    untyped: {},
  };
  for (const sd of childElements(ed, 'SchemaData')) {
    out.schemaUrl = sd.getAttribute?.('schemaUrl') || sd.getAttribute?.('schemaurl') || out.schemaUrl;
    for (const simple of childElements(sd, 'SimpleData')) {
      const key = simple.getAttribute?.('name') || simple.getAttribute?.('Name');
      if (!key) continue;
      out.data[key] = textOf(simple);
    }
  }
  for (const data of childElements(ed, 'Data')) {
    const key = data.getAttribute?.('name') || data.getAttribute?.('Name');
    if (!key) continue;
    const value = textOf(firstChild(data, 'value')) || textOf(data);
    out.untyped[key] = value;
  }
  if (!out.schemaUrl && !Object.keys(out.data).length && !Object.keys(out.untyped).length) return null;
  return out;
}

function geometryOptionsFromEl(el) {
  if (!el) return {};
  return {
    extrude: toBoolFlag(textOf(firstChild(el, 'extrude'))),
    tessellate: toBoolFlag(textOf(firstChild(el, 'tessellate'))),
    altitudeMode: textOf(firstChild(el, 'altitudeMode')) || null,
  };
}

function closeRing(coords) {
  if (!coords?.length) return coords;
  const a = coords[0];
  const b = coords[coords.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) return coords.concat([[a[0], a[1], ...(a.length > 2 ? [a[2]] : [])]]);
  return coords;
}

function geometryFromElement(el) {
  if (!el) return null;
  const tag = localName(el).toLowerCase();
  const opts = geometryOptionsFromEl(el);

  if (tag === 'point') {
    const c = parseCoordinateTuples(textOf(firstChild(el, 'coordinates')));
    if (!c.length) return null;
    return { type: 'Point', coordinates: c[0], ...opts };
  }
  if (tag === 'linestring') {
    const c = parseCoordinateTuples(textOf(firstChild(el, 'coordinates')));
    if (!c.length) return null;
    return { type: 'LineString', coordinates: c, ...opts };
  }
  if (tag === 'linearring') {
    const c = closeRing(parseCoordinateTuples(textOf(firstChild(el, 'coordinates'))));
    if (!c.length) return null;
    return { type: 'Polygon', coordinates: [c], ...opts };
  }
  if (tag === 'polygon') {
    const outerEl = firstChild(el, 'outerBoundaryIs');
    const ringEl = outerEl ? firstChild(outerEl, 'LinearRing') : firstChild(el, 'LinearRing');
    const outer = parseCoordinateTuples(textOf(firstChild(ringEl, 'coordinates')));
    if (!outer.length) return null;
    const rings = [closeRing(outer)];
    for (const inner of childElements(el, 'innerBoundaryIs')) {
      const innerRing = firstChild(inner, 'LinearRing');
      const coords = parseCoordinateTuples(textOf(firstChild(innerRing, 'coordinates')));
      if (coords.length) rings.push(closeRing(coords));
    }
    return { type: 'Polygon', coordinates: rings, ...opts };
  }
  if (tag === 'multigeometry') {
    const parts = [];
    for (const child of childElements(el)) {
      const g = geometryFromElement(child);
      if (!g) continue;
      if (g.type === 'GeometryCollection') parts.push(...g.geometries);
      else parts.push(g);
    }
    if (!parts.length) return null;
    if (parts.length === 1) {
      return {
        ...parts[0],
        ...opts,
        altitudeMode: opts.altitudeMode || parts[0].altitudeMode || null,
        extrude: opts.extrude != null ? opts.extrude : parts[0].extrude,
        tessellate: opts.tessellate != null ? opts.tessellate : parts[0].tessellate,
        multiGeometry: true,
      };
    }
    return { type: 'GeometryCollection', geometries: parts, multiGeometry: true, ...opts };
  }
  return null;
}

function firstGeometryChild(pm) {
  for (const child of childElements(pm)) {
    const tag = localName(child).toLowerCase();
    if (['point', 'linestring', 'linearring', 'polygon', 'multigeometry'].includes(tag)) {
      return child;
    }
  }
  return null;
}

function countGeomVertices(geom) {
  if (!geom) return 0;
  if (geom.type === 'GeometryCollection') {
    return (geom.geometries || []).reduce((n, g) => n + countGeomVertices(g), 0);
  }
  return countVertices(geom.coordinates);
}

function metricsForGeometry(geom) {
  if (!geom) return {};
  const alts = uniqueSorted(collectGeomAltitudes(geom));
  const vertexCount = countGeomVertices(geom);
  const bounds = featureBounds({ geometry: geom });
  const out = {
    vertexCount,
    bounds,
    altitudes: alts.length ? { min: alts[0], max: alts[alts.length - 1], values: alts } : null,
  };

  if (geom.type === 'Point') {
    out.lengthM = 0;
    out.areaM2 = 0;
  } else if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
    const coords =
      geom.type === 'LineString'
        ? geom.coordinates
        : (geom.coordinates || []).flat();
    out.lengthM = lineLengthMeters(coords);
    out.areaM2 = 0;
  } else if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
    let area = 0;
    let peri = 0;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates || [];
    for (const poly of polys) {
      const outer = poly?.[0];
      if (!outer) continue;
      area += ringAreaMeters2(outer);
      peri += lineLengthMeters(stripClosingDuplicate(outer).concat([outer[0]]));
      for (let i = 1; i < poly.length; i += 1) {
        area -= ringAreaMeters2(poly[i]);
      }
    }
    out.areaM2 = Math.max(0, area);
    out.perimeterM = peri;
    out.lengthM = peri;
  } else if (geom.type === 'GeometryCollection') {
    let area = 0;
    let length = 0;
    let peri = 0;
    for (const g of geom.geometries || []) {
      const m = metricsForGeometry(g);
      area += m.areaM2 || 0;
      length += m.lengthM || 0;
      peri += m.perimeterM || 0;
    }
    out.areaM2 = area;
    out.lengthM = length;
    out.perimeterM = peri || null;
  }
  return out;
}

function stylePropsFromStyleEl(styleEl) {
  const props = {};
  if (!styleEl) return props;
  const line = firstChild(styleEl, 'LineStyle');
  if (line) {
    const color = parseKmlColor(textOf(firstChild(line, 'color')));
    if (color) {
      props.stroke = color.color;
      props['stroke-opacity'] = color.opacity;
    }
    const width = toNum(textOf(firstChild(line, 'width')));
    if (width != null) props['stroke-width'] = width;
  }
  const poly = firstChild(styleEl, 'PolyStyle');
  if (poly) {
    const color = parseKmlColor(textOf(firstChild(poly, 'color')));
    if (color) {
      props.fill = color.color;
      props['fill-opacity'] = color.opacity;
    }
    if (textOf(firstChild(poly, 'fill')) === '0') props['fill-opacity'] = 0;
  }
  const iconStyle = firstChild(styleEl, 'IconStyle');
  if (iconStyle) {
    const href = textOf(firstChild(firstChild(iconStyle, 'Icon'), 'href'));
    if (href) props.icon = href;
    const scale = toNum(textOf(firstChild(iconStyle, 'scale')));
    if (scale != null) props['icon-scale'] = scale;
    const color = parseKmlColor(textOf(firstChild(iconStyle, 'color')));
    if (color) {
      props['icon-color'] = color.color;
      props['icon-opacity'] = color.opacity;
    }
  }
  return props;
}

function collectStyleIndex(root) {
  const styles = {};
  const styleIds = [];
  const styleMapIds = [];

  const walk = (el) => {
    if (!el || el.nodeType !== 1) return;
    const tag = localName(el).toLowerCase();
    if (tag === 'style') {
      const id = el.getAttribute?.('id');
      if (id) {
        styles[`#${id}`] = stylePropsFromStyleEl(el);
        styleIds.push(id);
      }
    } else if (tag === 'stylemap') {
      const id = el.getAttribute?.('id');
      if (id) styleMapIds.push(id);
    }
    for (const child of el.childNodes || []) walk(child);
  };
  walk(root);

  // Resolve StyleMaps to normal style
  const walkMaps = (el) => {
    if (!el || el.nodeType !== 1) return;
    if (localName(el).toLowerCase() === 'stylemap') {
      const id = el.getAttribute?.('id');
      if (id) {
        let normalUrl = null;
        for (const pair of childElements(el, 'Pair')) {
          if (textOf(firstChild(pair, 'key')) === 'normal') {
            normalUrl = textOf(firstChild(pair, 'styleUrl'));
            const inline = firstChild(pair, 'Style');
            if (inline) styles[`#${id}`] = stylePropsFromStyleEl(inline);
            break;
          }
        }
        if (normalUrl && styles[normalUrl]) styles[`#${id}`] = { ...styles[normalUrl] };
      }
    }
    for (const child of el.childNodes || []) walkMaps(child);
  };
  walkMaps(root);

  return { styles, styleIds, styleMapIds };
}

function collectSchemas(root) {
  const schemas = [];
  const walk = (el) => {
    if (!el || el.nodeType !== 1) return;
    if (localName(el).toLowerCase() === 'schema') {
      const id = el.getAttribute?.('id') || null;
      const name = el.getAttribute?.('name') || id;
      const fields = [];
      for (const field of childElements(el, 'SimpleField')) {
        fields.push({
          name: field.getAttribute?.('name') || null,
          type: field.getAttribute?.('type') || null,
        });
      }
      schemas.push({ id, name, fields });
    }
    for (const child of el.childNodes || []) walk(child);
  };
  walk(root);
  return schemas;
}

function extractProjectHints(pathValue) {
  if (!pathValue) return null;
  const s = String(pathValue);
  const hints = {
    raw: s,
    filePath: s.split('|')[0] || s,
    qgisParams: {},
  };
  for (const part of s.split('|').slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0) hints.qgisParams[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const projectMatch = hints.filePath.match(/(LC-\d{2}-\d{4}-\d{2}-\d{2}[^\\/]*)/i);
  if (projectMatch) hints.projectId = projectMatch[1];
  const orgMatch = hints.filePath.match(/([^\\/]*Organisation[^\\/]*)/i);
  if (orgMatch) hints.organisation = orgMatch[1];
  const conopsMatches = [...hints.filePath.matchAll(/([^\\/]*ConOps[^\\/]*)/gi)].map((m) => m[1]);
  if (conopsMatches.length) {
    hints.conops = conopsMatches[conopsMatches.length - 1];
    hints.conopsAll = conopsMatches;
  }
  if (/layername=/i.test(s) || /geometrytype=/i.test(s)) hints.likelyGis = 'QGIS';
  return hints;
}

function speedHintsFromSchemas(schemas) {
  const hints = [];
  for (const schema of schemas || []) {
    const blob = `${schema.name || ''} ${schema.id || ''}`;
    const m = blob.match(/(\d+)\s*kts?/i);
    if (m) {
      hints.push({
        schema: schema.name || schema.id,
        knots: Number(m[1]),
        label: `${m[1]} kts`,
      });
    }
  }
  return hints;
}

function buildFeatureMetricsProps(metrics) {
  const props = {};
  if (!metrics) return props;
  if (metrics.vertexCount != null) props.vertexCount = metrics.vertexCount;
  if (metrics.bounds) props.bounds = metrics.bounds;
  if (metrics.altitudes) props.altitudes = metrics.altitudes;
  if (Number.isFinite(metrics.areaM2) && metrics.areaM2 > 0) {
    props.areaM2 = round(metrics.areaM2, 1);
    props.areaKm2 = round(metrics.areaM2 / 1e6, 3);
  }
  if (Number.isFinite(metrics.perimeterM) && metrics.perimeterM > 0) {
    props.perimeterM = round(metrics.perimeterM, 1);
    props.perimeterKm = round(metrics.perimeterM / 1000, 3);
  }
  if (Number.isFinite(metrics.lengthM) && metrics.lengthM > 0 && !props.perimeterM) {
    props.lengthM = round(metrics.lengthM, 1);
    props.lengthKm = round(metrics.lengthM / 1000, 3);
  }
  return props;
}

function toGeoJsonGeometry(geom) {
  if (!geom) return null;
  if (geom.type === 'GeometryCollection') {
    return {
      type: 'GeometryCollection',
      geometries: (geom.geometries || []).map(toGeoJsonGeometry).filter(Boolean),
    };
  }
  return { type: geom.type, coordinates: geom.coordinates };
}

function placemarkToFeature(pm, folderPath, styleIndex) {
  const geomEl = firstGeometryChild(pm);
  if (!geomEl) return null;
  const geom = geometryFromElement(geomEl);
  if (!geom) return null;

  const name = textOf(firstChild(pm, 'name')) || 'Unnamed';
  const description = textOf(firstChild(pm, 'description'));
  const visibilityRaw = textOf(firstChild(pm, 'visibility'));
  const styleUrl = textOf(firstChild(pm, 'styleUrl'));
  const lookAt = parseLookAt(pm);
  const extended = parseExtendedData(pm);
  const metrics = metricsForGeometry(geom);
  const styleProps = styleUrl && styleIndex.styles[styleUrl] ? { ...styleIndex.styles[styleUrl] } : {};

  const data = extended?.data || {};
  const pathValue = data.path || extended?.untyped?.path || null;
  const layerValue = data.layer || extended?.untyped?.layer || null;
  const provenance = pathValue ? extractProjectHints(pathValue) : null;

  const props = {
    name,
    description: description || null,
    id: pm.getAttribute?.('id') || null,
    _folder: folderPath.length ? folderPath.join(' / ') : null,
    folderPath: folderPath.slice(),
    visibility: visibilityRaw === '' ? null : toBoolFlag(visibilityRaw),
    visibilityRaw: visibilityRaw || null,
    open: toBoolFlag(textOf(firstChild(pm, 'open'))),
    styleUrl: styleUrl || null,
    altitudeMode: geom.altitudeMode || data.altitudeMo || null,
    extrude: geom.extrude != null ? geom.extrude : toBoolFlag(data.extrude),
    tessellate: geom.tessellate != null ? geom.tessellate : toBoolFlag(data.tessellate),
    lookAt,
    schemaUrl: extended?.schemaUrl || null,
    extendedData: extended
      ? {
          ...data,
          ...extended.untyped,
        }
      : null,
    layer: layerValue,
    path: pathValue,
    provenance,
    geometryKind: geom.multiGeometry ? `MultiGeometry/${geom.type}` : geom.type,
    ...buildFeatureMetricsProps(metrics),
    ...styleProps,
  };

  return {
    type: 'Feature',
    properties: props,
    geometry: toGeoJsonGeometry(geom),
  };
}

function walkContainers(node, folderPath, styleIndex, out) {
  if (!node || node.nodeType !== 1) return;
  const tag = localName(node).toLowerCase();

  if (tag === 'placemark') {
    const feature = placemarkToFeature(node, folderPath, styleIndex);
    if (feature) out.features.push(feature);
    return;
  }

  if (tag === 'folder' || tag === 'document') {
    const name = textOf(firstChild(node, 'name'));
    // Keep Document name as file identity, not as a folder path segment.
    const nextPath = tag === 'folder' && name ? folderPath.concat(name) : folderPath;
    const visibilityRaw = textOf(firstChild(node, 'visibility'));
    if (tag === 'folder') {
      out.folderNodes.push({
        name: name || 'Folder',
        path: nextPath.slice(),
        visibility: visibilityRaw === '' ? null : toBoolFlag(visibilityRaw),
        visibilityRaw: visibilityRaw || null,
      });
    }
    for (const child of childElements(node)) {
      walkContainers(child, nextPath, styleIndex, out);
    }
    return;
  }

  for (const child of childElements(node)) {
    walkContainers(child, folderPath, styleIndex, out);
  }
}

function buildFolderSummary(folderNodes, features) {
  return (folderNodes || []).map((folder) => {
    const pathKey = folder.path.join(' / ');
    const kids = features.filter((f) => (f.properties._folder || '') === pathKey);
    return {
      ...folder,
      placemarkCount: kids.length,
      featureNames: kids.map((f) => f.properties.name),
    };
  });
}

function buildInventory({ docName, schemas, styleIndex, folderNodes, features, groundOverlays }) {
  const sourcePaths = [];
  const layers = [];
  const projectIds = [];
  let extent = null;
  let lookAts = 0;
  let withExtendedData = 0;
  let withAltitude = 0;

  const featureSummaries = features.map((f, index) => {
    const p = f.properties || {};
    if (p.lookAt) lookAts += 1;
    if (p.extendedData) withExtendedData += 1;
    if (p.altitudes) withAltitude += 1;
    if (p.path) sourcePaths.push(p.path);
    if (p.layer) layers.push(p.layer);
    if (p.provenance?.projectId) projectIds.push(p.provenance.projectId);
    extent = mergeBounds(extent, p.bounds || featureBounds(f));

    return {
      index,
      name: p.name,
      id: p.id,
      folder: p._folder,
      folderPath: p.folderPath || [],
      geometryType: p.geometryKind || f.geometry?.type,
      visibility: p.visibility,
      altitudeMode: p.altitudeMode,
      extrude: p.extrude,
      tessellate: p.tessellate,
      altitudes: p.altitudes,
      vertexCount: p.vertexCount,
      bounds: p.bounds,
      areaKm2: p.areaKm2 ?? null,
      perimeterKm: p.perimeterKm ?? null,
      lengthKm: p.lengthKm ?? null,
      lengthM: p.lengthM ?? null,
      lookAt: p.lookAt,
      schemaUrl: p.schemaUrl,
      layer: p.layer,
      path: p.path,
      provenance: p.provenance,
      styleUrl: p.styleUrl,
    };
  });

  const uniquePaths = [...new Set(sourcePaths)];
  const uniqueLayers = [...new Set(layers)];
  const uniqueProjects = [...new Set(projectIds)];
  const provenanceHints = uniquePaths.map(extractProjectHints).filter(Boolean);

  return {
    document: {
      name: docName || null,
      coordinateSystem: 'WGS84 (KML lon/lat)',
    },
    schemas,
    schemaSpeedHints: speedHintsFromSchemas(schemas),
    styles: {
      styleCount: styleIndex.styleIds.length,
      styleMapCount: styleIndex.styleMapIds.length,
      styleIds: styleIndex.styleIds,
      styleMapIds: styleIndex.styleMapIds,
    },
    folders: buildFolderSummary(folderNodes, features),
    features: featureSummaries,
    groundOverlays: (groundOverlays || []).map((g) => ({
      name: g.name,
      bounds: g.bounds,
      opacity: g.opacity,
      href: g.href,
    })),
    provenance: {
      sourcePaths: uniquePaths,
      layers: uniqueLayers,
      projectIds: uniqueProjects,
      hints: provenanceHints,
      organisations: [...new Set(provenanceHints.map((h) => h.organisation).filter(Boolean))],
      conops: [...new Set(provenanceHints.map((h) => h.conops).filter(Boolean))],
      likelyGis: [...new Set(provenanceHints.map((h) => h.likelyGis).filter(Boolean))],
    },
    extent,
    counts: {
      placemarks: features.length,
      folders: folderNodes.length,
      schemas: schemas.length,
      styles: styleIndex.styleIds.length,
      styleMaps: styleIndex.styleMapIds.length,
      lookAts,
      withExtendedData,
      withAltitude,
      groundOverlays: (groundOverlays || []).length,
      points: features.filter((f) => f.geometry?.type === 'Point').length,
      lines: features.filter((f) => String(f.geometry?.type || '').includes('Line')).length,
      polygons: features.filter((f) => String(f.geometry?.type || '').includes('Polygon')).length,
      collections: features.filter((f) => f.geometry?.type === 'GeometryCollection').length,
    },
  };
}

function findDocumentName(doc) {
  const root = doc.documentElement;
  const walk = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (localName(el).toLowerCase() === 'document') {
      const n = textOf(firstChild(el, 'name'));
      if (n) return n;
    }
    for (const child of el.childNodes || []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(root);
}

/**
 * Parse KML XML text into drawable pieces + full operational inventory.
 * @returns {{
 *   geojson: GeoJSON.FeatureCollection,
 *   groundOverlays: Array,
 *   folders: object|null,
 *   stats: object,
 *   inventory: object,
 * }}
 */
export async function parseKmlText(kmlText) {
  if (!kmlText || !String(kmlText).trim()) {
    throw new Error('Empty KML');
  }

  const dom = new DOMParser().parseFromString(String(kmlText), 'text/xml');
  const err = dom.querySelector('parsererror');
  if (err) throw new Error('Invalid KML XML');

  const styleIndex = collectStyleIndex(dom.documentElement);
  const schemas = collectSchemas(dom.documentElement);
  const docName = findDocumentName(dom);
  const bag = { features: [], folderNodes: [] };
  walkContainers(dom.documentElement, [], styleIndex, bag);

  const groundFromDom = extractGroundOverlaysFromDom(dom);
  const stats = emptyStats();
  stats.folders = bag.folderNodes.length;
  stats.schemas = schemas.length;
  stats.styles = styleIndex.styleIds.length;
  stats.styleMaps = styleIndex.styleMapIds.length;
  stats.groundOverlays = groundFromDom.length;

  let features = bag.features.slice();
  let folders = null;

  // Supplement with togeojson when available (gx:Track etc.). Inventory walk is primary.
  let api = null;
  try {
    api = await loadToGeoJson();
  } catch (_) {
    api = null;
  }
  if (api && typeof api.kmlWithFolders === 'function') {
    try {
      folders = api.kmlWithFolders(dom);
      stats.folders = Math.max(stats.folders, countFolders(folders));
    } catch (_) {
      folders = null;
    }
  }

  if (!features.length && api?.kml) {
    const fc = api.kml(dom);
    features = Array.isArray(fc?.features) ? fc.features.slice() : [];
  } else if (api?.kml) {
    try {
      const fc = api.kml(dom);
      const existingKeys = new Set(
        features.map((f) => `${f.properties?.name || ''}|${f.geometry?.type || ''}|${f.properties?.vertexCount || 0}`)
      );
      for (const f of fc?.features || []) {
        if (!f?.geometry) continue;
        if (isGroundOverlayFeature(f)) continue;
        const key = `${f.properties?.name || ''}|${f.geometry?.type || ''}|0`;
        if (existingKeys.has(key)) continue;
        if (
          [
            'Point',
            'LineString',
            'Polygon',
            'MultiPoint',
            'MultiLineString',
            'MultiPolygon',
            'GeometryCollection',
          ].includes(f.geometry.type)
        ) {
          continue;
        }
        features.push(f);
      }
    } catch (_) {
      /* ignore */
    }
  }

  const groundOverlays = [];
  const geoFeatures = [];
  const overlayHrefs = new Set(groundFromDom.map((g) => g.href));
  for (const g of groundFromDom) {
    groundOverlays.push(g);
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
      if (href && overlayHrefs.has(href)) continue;
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
      }
      continue;
    }

    tallyFeature(feature, stats);
    if (feature.properties?.lookAt) stats.lookAts += 1;
    if (feature.properties?.extendedData) stats.withExtendedData += 1;
    if (feature.properties?.altitudes) stats.withAltitude += 1;
    geoFeatures.push(feature);
  }

  const inventory = buildInventory({
    docName,
    schemas,
    styleIndex,
    folderNodes: bag.folderNodes,
    features: geoFeatures,
    groundOverlays,
  });

  return {
    geojson: {
      type: 'FeatureCollection',
      name: docName || undefined,
      features: geoFeatures,
    },
    groundOverlays,
    folders,
    stats,
    inventory,
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

export function summarizeStats(stats, inventory) {
  if (!stats && !inventory) return '';
  const parts = [];
  const s = stats || {};
  const c = inventory?.counts || {};
  const points = s.points || c.points || 0;
  const lines = s.lines || c.lines || 0;
  const polygons = s.polygons || c.polygons || 0;
  const overlays = s.groundOverlays || c.groundOverlays || 0;
  const folders = s.folders || c.folders || 0;
  if (points) parts.push(`${points} point${points === 1 ? '' : 's'}`);
  if (lines) parts.push(`${lines} line${lines === 1 ? '' : 's'}`);
  if (polygons) parts.push(`${polygons} polygon${polygons === 1 ? '' : 's'}`);
  if (overlays) parts.push(`${overlays} image overlay${overlays === 1 ? '' : 's'}`);
  if (folders) parts.push(`${folders} folder${folders === 1 ? '' : 's'}`);
  if (c.schemas) parts.push(`${c.schemas} schema${c.schemas === 1 ? '' : 's'}`);
  if (inventory?.schemaSpeedHints?.length) {
    parts.push(inventory.schemaSpeedHints.map((h) => h.label).join(', '));
  }
  return parts.join(' · ') || `${s.features || c.placemarks || 0} features`;
}
