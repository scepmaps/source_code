# source_code/server/headless.py
import io
import json
import os
from pathlib import Path
from typing import Dict

from dotenv import load_dotenv
from label_scaler import get_label_enhancement_css, get_label_enhancement_js
from PIL import Image
from playwright.sync_api import sync_playwright
from tilers import pixel_bounds_for_bbox, pixel_to_lonlat

load_dotenv(dotenv_path=Path(__file__).with_name(".env"))  # load source_code/server/.env

OPENAIP_KEY = os.getenv("OPENAIP_KEY")
# Option A: use backend proxy (recommended to hide key):
#   add the /tiles/openaip route as we discussed
OPENAIP_PROXY = os.getenv("OPENAIP_PROXY_URL") or (
    "http://127.0.0.1:5001/tiles/openaip/{z}/{x}/{y}.png" if OPENAIP_KEY else None
)  # prefer backend proxy

# Option B: direct to OpenAIP (shows key in requests)
OPENAIP_DIRECT = (
    f"https://{{s}}.api.tiles.openaip.net/api/data/openaip/{{z}}/{{x}}/{{y}}.png?apiKey={OPENAIP_KEY}"
    if OPENAIP_KEY
    else None
)

# Prefer proxy if provided, else direct, else None
OPENAIP_URL = OPENAIP_PROXY or OPENAIP_DIRECT

LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@4.1.2/dist/maplibre-gl.css"
MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@4.1.2/dist/maplibre-gl.js"
MAPLIBRE_LEAFLET_JS = "https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.0.20/leaflet-maplibre-gl.js"

# You can also swap OSM to a key-based provider for reliability:
HEADLESS_OSM_URL = os.getenv("HEADLESS_OSM_URL") or "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"

ARCGIS_API_KEY = os.getenv("ARCGIS_API_KEY")

# Build ESRI URL with optional API key
_esri_url = "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
if ARCGIS_API_KEY:
    _esri_url += "?token=" + ARCGIS_API_KEY

# Build Topo URL - using new static-map-tiles-api via backend proxy
# For headless export, use backend proxy (Playwright runs in browser context)
_topo_url = "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=arcgis/outdoor"

# Build Navigation URL - using new static-map-tiles-api via backend proxy
_navigation_url = "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=arcgis/navigation"

# Build Night URL - using new static-map-tiles-api via backend proxy
_night_url = "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=arcgis/streets-night"

# Build Ocean (Navigation Dark) URL - using new static-map-tiles-api via backend proxy
_ocean_url = "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=open/navigation-dark"

LAYER_URLS = {
    "osm": HEADLESS_OSM_URL,
    "esri": _esri_url,
    "topo": _topo_url,
    "navigation": _navigation_url,
    "night": _night_url,
    "ocean": _ocean_url,
    # Prefer the local proxy which supplies the Referer header
    "shom": os.getenv("HEADLESS_SHOM_URL", "http://127.0.0.1:5001/tiles/shom/{z}/{x}/{y}.png"),
    "ukho": os.getenv("HEADLESS_UKHO_URL", "http://127.0.0.1:5001/tiles/ukho/{z}/{x}/{y}.png"),
    "gbsouth": os.getenv("HEADLESS_GBSOUTH_URL", "http://127.0.0.1:5001/tiles/gbsouth/{z}/{x}/{y}.png"),
    "openseamap": "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
    "openaip": OPENAIP_URL,  # may be None
}

HTML = """<!doctype html>
<html>
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="%CSS%"/>
<link rel="stylesheet" href="%MAPLIBRE_CSS%"/>
<style>html,body,#map{height:100%;margin:0;padding:0}%ATTRIBUTION_CSS%</style>
%LABEL_CSS%
</head>
<body>
<div id="map"></div>
<script src="%JS%"></script>
<script src="%MAPLIBRE_JS%"></script>
<script src="%MAPLIBRE_LEAFLET_JS%"></script>
%LABEL_JS%
<script>
  const LAYER_URLS = %LAYER_URLS%;
  const bbox = %BBOX%;   // [w,s,e,n]
  const zoom = %ZOOM%;
  const base = "%BASE%";
  const overlays = %OVERLAYS%;
  const API_BASE = "%API_BASE%";  // Base URL for API endpoints (empty string or full URL)

  // Vector tile style URLs - these match the frontend config
  const VECTOR_STYLE_URLS = {
    'ocean': API_BASE + '/api/arcgis/style/open/navigation-dark',
    'topo': API_BASE + '/api/arcgis/style/arcgis/topographic',
    'night': API_BASE + '/api/arcgis/style/arcgis/streets-night',
    'navigation': API_BASE + '/api/arcgis/style/arcgis/navigation'
  };

  // Check if current base is a vector tile layer
  const isVectorLayer = base in VECTOR_STYLE_URLS;

  const map = L.map('map', {
    zoomControl:false,
    attributionControl:false,
    preferCanvas:true,
    zoomAnimation:false,
    fadeAnimation:false,
    inertia:false
  });

  // Add attribution control without Ukraine flag if enabled
  let attributionControl = null;
  if (%SHOW_ATTRIBUTION%) {
    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
    attributionControl = L.control.attribution({
      prefix: '<a href="https://leafletjs.com" title="A JavaScript library for interactive maps">Leaflet</a> | ' + timestamp
    }).addTo(map);
  }
  map.setView([(bbox[1]+bbox[3])/2,(bbox[0]+bbox[2])/2], zoom);

  // Dedicated pane for label-only overlay layers ("Names")
  map.createPane('labelPane');
  map.getPane('labelPane').style.zIndex = 450;

  // Snap map pixel origin so that the viewport aligns EXACTLY to the bbox
  try {
    const north = bbox[3], west = bbox[0];
    const pTL = map.project([north, west], zoom); // desired top-left pixel
    const origin = map.getPixelOrigin();          // current pixel origin (top-left of viewport)
    const dx = pTL.x - origin.x;
    const dy = pTL.y - origin.y;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      map.panBy([dx, dy], {animate:false});
    }
  } catch(_){}

  function mk(url, opts){ return url ? L.tileLayer(url, opts) : null; }

  // Attributions matching frontend config.js
  const ATTRIBUTIONS = {
    osm: '&copy; OpenStreetMap contributors',
    esri: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics',
    topo: 'Tiles &copy; Esri — Sources: Esri, HERE, Garmin, USGS, NPS',
    navigation: 'Tiles &copy; Esri — Source: Esri, HERE, Garmin, FAO, NOAA',
    night: 'Tiles &copy; Esri — Source: Esri, HERE, Garmin, USGS, NGA',
    ocean: 'Tiles &copy; Esri — Source: Esri, OSM, Natural Earth',
    shom: 'Charts &copy; SHOM',
    ukho: 'Charts derived from UKHO data',
    gbsouth: 'Rogers data 500k GB south',
    openseamap: 'Seamarks &copy; OpenSeaMap contributors',
    openaip: '&copy; openAIP'
  };

  const osm  = mk(LAYER_URLS.osm,  { maxZoom: 20, attribution: ATTRIBUTIONS.osm });
  const esri = mk(LAYER_URLS.esri, { maxZoom: 20, attribution: ATTRIBUTIONS.esri });
  const topo = mk(LAYER_URLS.topo, { maxZoom: 20, attribution: ATTRIBUTIONS.topo });
  const navigation = mk(LAYER_URLS.navigation, { maxZoom: 20, attribution: ATTRIBUTIONS.navigation });
  const night = mk(LAYER_URLS.night, { maxZoom: 20, attribution: ATTRIBUTIONS.night });
  const ocean = mk(LAYER_URLS.ocean, { maxZoom: 20, attribution: ATTRIBUTIONS.ocean });
  const shomOverlay = mk(LAYER_URLS.shom, { maxZoom: 18, attribution: ATTRIBUTIONS.shom });
  const ukhoOverlay = mk(LAYER_URLS.ukho, { maxZoom: 18, attribution: ATTRIBUTIONS.ukho });
  const gbsouthOverlay = mk(LAYER_URLS.gbsouth, { maxZoom: 12, minZoom: 6, attribution: ATTRIBUTIONS.gbsouth });
  const seamarks = mk(LAYER_URLS.openseamap, { maxZoom:20, opacity:0.9, attribution: ATTRIBUTIONS.openseamap });
  const openaip  = mk(LAYER_URLS.openaip,    { maxZoom:20, opacity:0.9, attribution: ATTRIBUTIONS.openaip });

  // robust tile load tracking
  let pending = 0, idleTimer=null;
  function startIdle(){ if (pending===0 && !idleTimer){ idleTimer=setTimeout(()=>{window.__tilesLoaded=true;},500); } }
  function cancelIdle(){ if (idleTimer){ clearTimeout(idleTimer); idleTimer=null; } }
  function hook(layer){
    if (!layer || !layer.on) return;
    layer.on('loading', ()=>{ pending++; cancelIdle(); });
    layer.on('load',    ()=>{ pending=Math.max(0,pending-1); startIdle(); });
    layer.on('tileloadstart',()=>{ pending++; cancelIdle(); });
    layer.on('tileload',()=>{ pending=Math.max(0,pending-1); startIdle(); });
    layer.on('tileerror',(e)=>{
      // Make tiles transparent on error so base layer shows through
      if (e?.tile) e.tile.style.opacity = '0';
      pending=Math.max(0,pending-1); startIdle();
    });
  }

  // SHOM, UKHO, and gbsouth are now overlays on top of OSM base
  let baseLayer = null;
  let vectorGlLayer = null;
  let vectorGlMap = null;
  let labelsGlLayer = null;
  let labelsGlMap = null;

  function buildLabelsOnlyStyle(styleJson){
    const allLayers = Array.isArray(styleJson?.layers) ? styleJson.layers : [];
    const isRoadLabelLayer = (layer) => {
      const id = (layer?.id || '').toLowerCase();
      const sourceLayer = (layer?.['source-layer'] || '').toLowerCase();
      const textField = String(layer?.layout?.['text-field'] || '').toLowerCase();
      const haystack = `${id} ${sourceLayer}`;
      if (/road|street|highway|motorway|route|transport|shield|ref/.test(haystack)) return true;
      // Note: escape backslashes for Python string literal (so JS regex gets escaped braces)
      if (/\\{ref\\}|road_ref|route_ref/.test(textField)) return true;
      return false;
    };

    const labelLayers = allLayers
      .filter(layer => layer?.type === 'symbol' && layer?.layout && layer.layout['text-field'])
      .filter(layer => !isRoadLabelLayer(layer))
      .map(layer => ({
        ...layer,
        paint: {
          ...(layer.paint || {}),
          'text-color': '#000000',
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.4
        }
      }));

    return {
      version: styleJson.version || 8,
      name: 'Labels Only Overlay',
      metadata: styleJson.metadata || {},
      sources: styleJson.sources || {},
      sprite: styleJson.sprite,
      glyphs: styleJson.glyphs,
      layers: labelLayers
    };
  }

  if (base === 'shom' && shomOverlay) {
    baseLayer = osm;
    if (baseLayer) { hook(baseLayer); baseLayer.addTo(map); }
    hook(shomOverlay); shomOverlay.addTo(map);
  } else if (base === 'ukho' && ukhoOverlay) {
    baseLayer = osm;
    if (baseLayer) { hook(baseLayer); baseLayer.addTo(map); }
    hook(ukhoOverlay); ukhoOverlay.addTo(map);
  } else if (base === 'gbsouth' && gbsouthOverlay) {
    baseLayer = osm;
    if (baseLayer) { hook(baseLayer); baseLayer.addTo(map); }
    hook(gbsouthOverlay); gbsouthOverlay.addTo(map);
  } else if (isVectorLayer) {
    // Vector tile layers (ocean, topo, night, navigation) - use MapLibre GL
    const styleUrl = VECTOR_STYLE_URLS[base];
    if (styleUrl) {
      // Mark as loading immediately
      pending++;
      cancelIdle();

      (async () => {
        try {
          const styleResponse = await fetch(styleUrl);
          if (styleResponse.ok) {
            const styleJson = await styleResponse.json();
            vectorGlLayer = L.maplibreGL({
              style: styleJson,
              interactive: false,
              pane: 'basePane'
            }).addTo(map);
            vectorGlMap = vectorGlLayer.getMaplibreMap();

            // Add attribution for vector layer
            if (attributionControl && ATTRIBUTIONS[base]) {
              attributionControl.addAttribution(ATTRIBUTIONS[base]);
            }

            // Track MapLibre GL load events - wait for both style load and tiles to load
            let styleLoaded = false;
            let tilesLoaded = false;

            const checkComplete = () => {
              if (styleLoaded && tilesLoaded) {
                pending = Math.max(0, pending - 1);
                startIdle();
              }
            };

            vectorGlMap.on('load', () => {
              styleLoaded = true;
              checkComplete();
            });

            vectorGlMap.on('idle', () => {
              tilesLoaded = true;
              checkComplete();
            });

            vectorGlMap.on('error', (e) => {
              console.error('MapLibre GL error:', e);
              pending = Math.max(0, pending - 1);
              startIdle();
            });
          } else {
            console.warn('Failed to load vector style, falling back to raster');
            // Fallback to raster
            const bases = { osm, esri, topo, navigation, night, ocean };
            baseLayer = bases[base] || osm;
            if (baseLayer) { hook(baseLayer); baseLayer.addTo(map); }
            pending = Math.max(0, pending - 1);
            startIdle();
          }
        } catch (err) {
          console.error('Error loading vector style:', err);
          // Fallback to raster
          const bases = { osm, esri, topo, navigation, night, ocean };
          baseLayer = bases[base] || osm;
          if (baseLayer) { hook(baseLayer); baseLayer.addTo(map); }
          pending = Math.max(0, pending - 1);
          startIdle();
        }
      })();
    } else {
      // No style URL, fallback to raster
      const bases = { osm, esri, topo, navigation, night, ocean };
      baseLayer = bases[base] || osm;
      if (baseLayer) { hook(baseLayer); baseLayer.addTo(map); }
    }
  } else {
    // Raster tile layers (OSM, ESRI) - use Leaflet tile layers
    const bases = { osm, esri };
    baseLayer = bases[base] || osm;
    if (baseLayer) { hook(baseLayer); baseLayer.addTo(map); }
  }

  if (overlays.seamarks && seamarks){ hook(seamarks); seamarks.addTo(map); }
  if (overlays.openaip  && openaip ){ hook(openaip ); openaip .addTo(map); }
  if (overlays.label) {
    // Build a "names-only" MapLibre GL layer from the navigation vector style.
    // (Same approach as the interactive frontend "Names" toggle.)
    pending++;
    cancelIdle();

    (async () => {
      try {
        const styleUrl = VECTOR_STYLE_URLS.navigation;
        const styleResponse = await fetch(styleUrl);
        if (!styleResponse.ok) {
          throw new Error(`Failed to fetch names style: ${styleResponse.status}`);
        }
        const fullStyle = await styleResponse.json();
        const labelsStyle = buildLabelsOnlyStyle(fullStyle);
        if (!labelsStyle.layers.length) {
          console.warn('[Names] No text symbol layers found in style');
          pending = Math.max(0, pending - 1);
          startIdle();
          return;
        }

        labelsGlLayer = L.maplibreGL({
          style: labelsStyle,
          interactive: false,
          pane: 'labelPane'
        }).addTo(map);

        labelsGlMap = labelsGlLayer.getMaplibreMap();

        let styleLoaded = false;
        let tilesLoaded = false;
        const checkComplete = () => {
          if (styleLoaded && tilesLoaded) {
            pending = Math.max(0, pending - 1);
            startIdle();
          }
        };

        labelsGlMap?.on('load', () => {
          styleLoaded = true;
          checkComplete();
        });

        labelsGlMap?.on('idle', () => {
          tilesLoaded = true;
          checkComplete();
        });

        labelsGlMap?.on('error', (e) => {
          console.error('[Names] MapLibre GL error:', e);
          pending = Math.max(0, pending - 1);
          startIdle();
        });
      } catch (err) {
        console.error('[Names] Failed to create vector labels overlay:', err);
        pending = Math.max(0, pending - 1);
        startIdle();
      }
    })();
  }

  setTimeout(()=>{ window.__tilesLoaded = true; }, 15000); // hard cap
</script>
</body>
</html>
""".replace(
    "%CSS%", LEAFLET_CSS
).replace(
    "%JS%", LEAFLET_JS
)


def render_headless_map(
    bbox4326, zoom: int, width: int, height: int, base: str, overlays: Dict[str, bool], show_attribution: bool = True
):
    try:
        # Determine the pixel dimensions of the bbox at the given zoom. The viewport
        # must match these dimensions so that the rendered map covers exactly the
        # requested area regardless of the requested output resolution.
        left, top, right, bottom = pixel_bounds_for_bbox(bbox4326, zoom)
        view_w = int(round(right - left))
        view_h = int(round(bottom - top))

        if view_w <= 0 or view_h <= 0:
            raise ValueError(f"Invalid viewport dimensions: {view_w}x{view_h}")

        # Use higher scale factor for better quality exports
        # This ensures the browser renders at higher resolution than the viewport
        scale = max(2.0, width / view_w) if view_w else 2.0

        # Scale attribution from FINAL TIFF dimensions (export box result), not from render oversampling.
        # This keeps tiny export boxes discreet instead of inflating the text.
        min_dim = max(1.0, float(min(width, height)))
        # ~1.8% of smaller side, with conservative bounds.
        attr_font_px = max(8, min(13, int(round(min_dim * 0.018))))
        # Padding scales gently with font size.
        attr_padding_y = max(1, min(4, int(round(attr_font_px * 0.2))))
        attr_padding_x = max(3, min(8, int(round(attr_font_px * 0.45))))
        attribution_css = (
            ".leaflet-control-attribution{"
            f"font-size:{attr_font_px}px;"
            f"padding:{attr_padding_y}px {attr_padding_x}px;"
            "line-height:1.25;"
            "}"
        )

        # Validate that we have required layer URLs
        if base == "openaip" and not LAYER_URLS.get("openaip"):
            raise ValueError("OpenAIP layer not configured (missing API key)")

        # Add label enhancement for ArcGIS maps
        # Note: ocean uses Open Basemaps which may not need the same enhancement, but include it for consistency
        is_arcgis = base in ("esri", "topo", "navigation", "night", "ocean")
        label_css = get_label_enhancement_css(zoom) if is_arcgis else ""
        label_js = get_label_enhancement_js(zoom) if is_arcgis else ""

        # Determine API base URL for headless browser context
        # In headless export, we need to use absolute URLs since set_content() doesn't have a base URL
        # Default to localhost:5001 which is where the Flask server runs
        api_base = os.getenv("HEADLESS_API_BASE", "http://127.0.0.1:5001")

        html = (
            HTML.replace("%LAYER_URLS%", json.dumps(LAYER_URLS))
            .replace("%BBOX%", json.dumps(bbox4326))
            .replace("%ZOOM%", json.dumps(int(zoom)))
            .replace("%BASE%", base)
            .replace("%OVERLAYS%", json.dumps(overlays))
            .replace("%LABEL_CSS%", label_css)
            .replace("%LABEL_JS%", label_js)
            .replace("%CSS%", LEAFLET_CSS)
            .replace("%JS%", LEAFLET_JS)
            .replace("%MAPLIBRE_CSS%", MAPLIBRE_CSS)
            .replace("%MAPLIBRE_JS%", MAPLIBRE_JS)
            .replace("%MAPLIBRE_LEAFLET_JS%", MAPLIBRE_LEAFLET_JS)
            .replace("%API_BASE%", api_base)
            .replace("%SHOW_ATTRIBUTION%", "true" if show_attribution else "false")
            .replace("%ATTRIBUTION_CSS%", attribution_css)
        )

        browser = None
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                ctx = browser.new_context(
                    viewport={"width": view_w, "height": view_h},
                    device_scale_factor=scale,
                    user_agent="Mozilla/5.0 (Playwright) slippy-to-geotiff",
                    extra_http_headers={
                        # Helps SHOM upstream when not going through proxy (kept safe to send generally)
                        "Referer": os.getenv("TILE_REFERER", "https://data.shom.fr/")
                    },
                )
                page = ctx.new_page()
                page.set_content(html, wait_until="domcontentloaded")
                page.wait_for_timeout(500)  # Wait for scripts to load
                # Wait for both raster tiles and vector tiles to load
                # Vector tiles use MapLibre GL which has its own load event
                page.wait_for_function("() => window.__tilesLoaded === true", timeout=45000)
                # Additional wait for MapLibre GL to fully render vector tiles
                page.wait_for_timeout(2000)  # Give MapLibre GL time to render all vector tiles
                png = page.locator("#map").screenshot(type="png")
                ctx.close()
                browser.close()
        except Exception as e:
            if browser:
                try:
                    browser.close()
                except:
                    pass
            raise RuntimeError(f"Browser rendering failed: {str(e)}")

        im = Image.open(io.BytesIO(png)).convert("RGBA")
        # Do NOT resize here; return at native pixel size and let rasterio resample during reprojection
        # This keeps pixel centers aligned with the georeferenced transform.

        # Compute exact bbox aligned to the integer pixel grid at the given zoom
        left_i = int(round(left))
        top_i = int(round(top))
        right_i = int(round(right))
        bottom_i = int(round(bottom))
        west, north = pixel_to_lonlat(left_i, top_i, zoom)
        east, south = pixel_to_lonlat(right_i, bottom_i, zoom)
        exact_bbox4326 = (min(west, east), min(south, north), max(west, east), max(south, north))

        return im, exact_bbox4326
    except Exception as e:
        print(f"Error in render_headless_map: {e}")
        raise
