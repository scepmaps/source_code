import { LAYERS } from './config.js?v=20260805c';
import { createToolbarController } from './toolbar/toolbar.js?v=20260806e';
import { initSettingsController } from './settings/settings.js?v=20260805c';
import { initZoomMechanics } from './zoom/zoom.js?v=20260805c';
import { initMapToolControls } from './tools/tools.js?v=20260805c';
import { startOnboardingTour, shouldAutoStartOnboardingTour } from './onboarding.js?v=20260805c';
import { applySessionResponse, startSessionKeepalive, validateSession } from './auth-session.js?v=20260805c';
import { absolutizeMapStyleUrls, makeArcgisTransformRequest } from './map-style.js?v=20260805c';

// Auth gate: require login, attach token to export calls (Bearer JWT in localStorage — no cookies)
let token = localStorage.getItem('token');
let user = JSON.parse(localStorage.getItem('user')||'null');
if (!token || !user) {
  location.href = 'login.html';
  throw new Error('Not authenticated'); // Stop script execution
}

const sessionHooks = {
  onToken: (next) => { token = next; },
  onUser: (next) => { user = next; },
};

// Refresh user permissions + sliding JWT from server
try {
  user = await validateSession(token, sessionHooks);
} catch (e) {
  if (e.message === 'Invalid token') throw e;
  console.warn('Network error refreshing user, using cached data');
}

startSessionKeepalive(() => token, sessionHooks);

// Hide loading screen and show app after auth check passes
document.getElementById('authLoading').style.display = 'none';
document.getElementById('app').style.display = 'flex';
// Note: map.invalidateSize() moved below after map is created

// Update branding based on fun mode
if (user?.fun) {
  const brandElements = document.querySelectorAll('.brand, .loading-logo');
  brandElements.forEach(el => {
    if (el.classList.contains('brand')) {
      el.innerHTML = '<span class="glow-dot"></span>PAMERKUF';
    } else {
      el.textContent = 'PAMERKUF';
    }
  });
}

const adminBtn = document.getElementById('adminBtn');
const isMobileApp = document.body.classList.contains('mobile-app');
if (adminBtn) {
  if (!user?.is_admin) adminBtn.style.display = 'none';
  adminBtn.addEventListener('click', ()=>{ if(user?.is_admin){ location.href='admin.html'; } });
}
document.getElementById('logoutBtn')?.addEventListener('click', ()=>{ localStorage.removeItem('token'); localStorage.removeItem('user'); location.href='login.html'; });

// Use user's default position if set, otherwise use default
const defaultLat = (user.default_lat !== null && user.default_lat !== undefined) ? user.default_lat : 50.9585;
const defaultLon = (user.default_lon !== null && user.default_lon !== undefined) ? user.default_lon : 0.9325;
const defaultZoom = (user.default_zoom !== null && user.default_zoom !== undefined) ? user.default_zoom : 15;

const map = L.map('map', { zoomControl: true }).setView([defaultLat, defaultLon], defaultZoom);
map.invalidateSize(); // Ensure map renders correctly after display change

// Mobile: keep dock height CSS var in sync and remeasure the map so tiles fill the visible area.
function syncMobileMapChrome() {
  if (!isMobileApp) return;
  const dock = document.getElementById('sideRail');
  if (dock) {
    const h = Math.ceil(dock.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--mobile-dock-height', `${h}px`);
  }
  map.invalidateSize({ animate: false });
}
if (isMobileApp) {
  window.addEventListener('resize', syncMobileMapChrome);
  window.addEventListener('orientationchange', () => setTimeout(syncMobileMapChrome, 150));
  requestAnimationFrame(syncMobileMapChrome);
  setTimeout(syncMobileMapChrome, 100);
  setTimeout(syncMobileMapChrome, 400);
}
const DEFAULT_MAP_ZOOM_LIMITS = { min: 1, max: 19 };
const BASE_NATIVE_MAX_ZOOM = {
  // OSM standard slippy tiles are typically served up to z19.
  osm: 19,
  // ArcGIS World Imagery currently stops serving tiles beyond z19 in this setup.
  esri: 19,
  shom: 18,
  ukho: 18,
  gbsouth: 12
};
const BASE_ZOOM_LIMITS = {
  osm: { min: 1, max: 19 },
  esri: { min: 1, max: 19 },
  // Vector basemaps: cap at 19 to avoid over-zoom beyond typical source detail.
  topo: { min: 1, max: 19 },
  navigation: { min: 1, max: 19 },
  night: { min: 1, max: 19 },
  ocean: { min: 1, max: 19 },
  shom: { min: 1, max: 18 },
  ukho: { min: 1, max: 18 },
  gbsouth: { min: 6, max: 12 }
};

function getZoomLimitsForBase(baseType) {
  return BASE_ZOOM_LIMITS[baseType] || DEFAULT_MAP_ZOOM_LIMITS;
}

function createBaseRasterLayer(baseType, url, attribution) {
  const opts = {
    attribution,
    maxZoom: DEFAULT_MAP_ZOOM_LIMITS.max,
    pane: 'basePane'
  };
  const maxNativeZoom = BASE_NATIVE_MAX_ZOOM[baseType];
  if (Number.isFinite(maxNativeZoom)) {
    opts.maxNativeZoom = maxNativeZoom;
  }
  // Raster tiles load via <img> tags and cannot send Authorization headers.
  // Inject the JWT as ?t= so the server-side proxy can authenticate the request.
  const tileUrl = url.includes('/tiles/arcgis/')
    ? url + '&t=' + (localStorage.getItem('token') || '')
    : url;
  return L.tileLayer(tileUrl, opts);
}

function applyZoomLimitsForBase(baseType) {
  const limits = getZoomLimitsForBase(baseType);
  map.setMinZoom(limits.min);
  map.setMaxZoom(limits.max);

  const currentZoom = map.getZoom();
  if (currentZoom < limits.min) {
    map.setZoom(limits.min);
  } else if (currentZoom > limits.max) {
    map.setZoom(limits.max);
  }
}

map.createPane('basePane'); map.getPane('basePane').style.zIndex = 200;
map.createPane('chartsPane'); map.getPane('chartsPane').style.zIndex = 300; // SHOM/GBSouth charts
map.createPane('densityPane'); map.getPane('densityPane').style.zIndex = 350; // Population density
map.createPane('overlayPane'); map.getPane('overlayPane').style.zIndex = 400; // Seamarks/OpenAIP
map.createPane('labelPane'); map.getPane('labelPane').style.zIndex = 450; // Labeled map

map.createPane('exportPane'); map.getPane('exportPane').style.zIndex = 600;
map.createPane('selectionPane'); map.getPane('selectionPane').style.zIndex = 800;
map.createPane('rulerLabelsPane'); map.getPane('rulerLabelsPane').style.zIndex = 900; // Labels on top
const exportHistory = L.layerGroup().addTo(map);
let selectionRect = null;
let hgtSelectionRect = null;
let isDrawingBox = false;
let drawingBoxType = 'map';
let boxStart = null;
let pendingCorner = null;
let longPressTimer = null;
let drawingOverlay = null;  // Transparent overlay to capture events while drawing
let isHgtActive = false;
let hgtControlBtn = null;
let rulerControlBtn = null;
let refreshBoxButton = () => {};
const HGT_MIN_LAT = -56;
const HGT_MAX_LAT = 60;
const HGT_EXPORT_MAX_TILES = 1600;
let hgtAvailabilityOverlay = null;

function isMapBoxDrawingActive() {
  return isDrawingBox && drawingBoxType === 'map';
}

function isHgtBoxDrawingActive() {
  return isDrawingBox && drawingBoxType === 'hgt';
}

function refreshHgtAvailabilityOverlay(){
  if (!isHgtActive) {
    if (hgtAvailabilityOverlay && map.hasLayer(hgtAvailabilityOverlay)) {
      map.removeLayer(hgtAvailabilityOverlay);
    }
    return;
  }

  const excludedStyle = {
    pane: 'exportPane',
    interactive: false,
    stroke: false,
    fillColor: '#000',
    fillOpacity: 0.35
  };
  const limitLineStyle = {
    pane: 'selectionPane',
    interactive: false,
    color: '#c1121f',
    weight: 2,
    opacity: 0.95,
    dashArray: '8,6'
  };

  if (!hgtAvailabilityOverlay) {
    hgtAvailabilityOverlay = L.layerGroup();
  } else {
    hgtAvailabilityOverlay.clearLayers();
  }

  // At low zoom the map shows multiple horizontal "world" copies; draw the HGT limit overlay
  // once per visible copy (longitude wrapped by 360°) so excluded bands repeat correctly.
  const b = map.getBounds();
  let west = b.getWest();
  let east = b.getEast();
  let kMin;
  let kMax;
  if (east >= west) {
    kMin = Math.ceil((west - 180) / 360);
    kMax = Math.floor((east + 180) / 360);
  } else {
    // Rare: bounds cross the antimeridian; draw a few world copies so limits still show.
    kMin = -2;
    kMax = 2;
  }
  for (let k = kMin; k <= kMax; k++) {
    const o = k * 360;
    L.rectangle([[HGT_MAX_LAT, -180 + o], [90, 180 + o]], excludedStyle).addTo(hgtAvailabilityOverlay);
    L.rectangle([[-90, -180 + o], [HGT_MIN_LAT, 180 + o]], excludedStyle).addTo(hgtAvailabilityOverlay);
    L.polyline([[HGT_MAX_LAT, -180 + o], [HGT_MAX_LAT, 180 + o]], limitLineStyle).addTo(hgtAvailabilityOverlay);
    L.polyline([[HGT_MIN_LAT, -180 + o], [HGT_MIN_LAT, 180 + o]], limitLineStyle).addTo(hgtAvailabilityOverlay);
  }

  if (!map.hasLayer(hgtAvailabilityOverlay)) {
    hgtAvailabilityOverlay.addTo(map);
  }
}

map.on('moveend zoomend', () => {
  if (isHgtActive) refreshHgtAvailabilityOverlay();
});

function refreshHgtControlButton(){
  if (!hgtControlBtn) return;
  hgtControlBtn.classList.remove('map-tool-btn--danger', 'map-tool-btn--armed');
  let tip = 'HGT';
  if (hgtSelectionRect){
    hgtControlBtn.classList.add('map-tool-btn--danger');
    tip = 'Delete HGT';
  } else if (isHgtBoxDrawingActive()){
    hgtControlBtn.classList.add('map-tool-btn--armed');
    tip = 'Place HGT';
  }
  hgtControlBtn.dataset.tip = tip;
  hgtControlBtn.setAttribute('aria-label', tip);
  hgtControlBtn.removeAttribute('title');
  if (typeof updateMoreButtonsHighlight === 'function') updateMoreButtonsHighlight();
}

function setRulerControlActive(active) {
  if (!rulerControlBtn) return;
  rulerControlBtn.classList.toggle('map-tool-btn--active', !!active);
  if (typeof updateMoreButtonsHighlight === 'function') updateMoreButtonsHighlight();
}

// Build layers based on user permissions
const defaultBases = ['osm','esri','topo','navigation','night','ocean','shom','ukho','gbsouth'];
const defaultOver  = ['seamarks','openaip','density','label','history'];
const defaultTools = ['hgt'];
// Permission interpretation:
// - null/undefined: unrestricted (use all defaults)
// - []: explicitly no access to anything
// - [...]: whitelist of allowed items
const rawBases = user?.allowed_bases;
const rawOver  = user?.allowed_overlays;
const rawTools = user?.allowed_tools;

let allowedBases, allowedOver, allowedTools;
if (rawBases === null || rawBases === undefined) {
  allowedBases = defaultBases; // unrestricted
} else if (Array.isArray(rawBases)) {
  allowedBases = rawBases; // explicit list (could be empty)
  // Ensure OSM is always available as a free fallback option
  if (!allowedBases.includes('osm')) {
    allowedBases.push('osm');
    console.log('[Permissions] OSM added as free fallback option');
  }
} else {
  allowedBases = defaultBases; // fallback
}

if (rawOver === null || rawOver === undefined) {
  allowedOver = defaultOver; // unrestricted
} else if (Array.isArray(rawOver)) {
  allowedOver = rawOver; // explicit list (could be empty - all overlays can be disabled)
} else {
  allowedOver = defaultOver; // fallback
}

// Density is an explicit admin-controlled permission for non-admin users.
// Even if overlays are otherwise unrestricted, hide density unless it is
// explicitly present in allowed_overlays.
const densityExplicitlyAllowed = Array.isArray(rawOver) && rawOver.includes('density');
if (!user?.is_admin && !densityExplicitlyAllowed) {
  allowedOver = allowedOver.filter((item) => item !== 'density');
}

if (rawTools === null || rawTools === undefined) {
  allowedTools = defaultTools; // unrestricted
} else if (Array.isArray(rawTools)) {
  allowedTools = rawTools; // explicit list (could be empty)
} else {
  allowedTools = defaultTools; // fallback
}
const layerDefs = {};
// OSM and ArcGIS maps are true base layers
if (allowedBases.includes('osm'))  layerDefs.osm  = createBaseRasterLayer('osm', LAYERS.osm.url, LAYERS.osm.attribution);
if (allowedBases.includes('esri')) layerDefs.esri = createBaseRasterLayer('esri', LAYERS.esri.url, LAYERS.esri.attribution);
// Topo is now a vector layer, so we don't create it here - it will be created via createTopoLayer() when selected
// if (allowedBases.includes('topo')) layerDefs.topo = ... // Topo is now vector, handled separately
// Navigation is now a vector layer, so we don't create it here - it will be created via createNavigationLayer() when selected
// if (allowedBases.includes('navigation')) layerDefs.navigation = ... // Navigation is now vector, handled separately
// Night is now a vector layer, so we don't create it here - it will be created via createNightLayer() when selected
// if (allowedBases.includes('night')) layerDefs.night = ... // Night is now vector, handled separately

// SHOM, UKHO, and gbsouth are overlays on top of OSM (since they can be partially transparent)
let shomOverlay = null, ukhoOverlay = null, gbsouthOverlay = null;

if (allowedBases.includes('shom')) {
  shomOverlay = L.tileLayer(LAYERS.shom.url, {
    attribution: LAYERS.shom.attribution,
    maxZoom: 18, // SHOM tiles are typically available up to zoom 18
    maxNativeZoom: 18,
    pane: 'chartsPane'
  });

  // Track failed tiles and retry attempts
  const failedTiles = new Map();
  const maxRetries = 2;

  shomOverlay.on('tileerror', (e) => {
    try {
      const coords = e?.coords;
      if (!coords) return;

      const tileKey = `${coords.z}_${coords.x}_${coords.y}`;
      const retryCount = failedTiles.get(tileKey) || 0;

      if (retryCount < maxRetries) {
        // Retry the SHOM tile with a slight delay
        failedTiles.set(tileKey, retryCount + 1);
        setTimeout(() => {
          const newUrl = LAYERS.shom.url
            .replace('{z}', coords.z)
            .replace('{x}', coords.x)
            .replace('{y}', coords.y) + '?retry=' + (retryCount + 1);
          e.tile.src = newUrl;
        }, 500 + (retryCount * 1000)); // Exponential backoff
      } else {
        // Make tile transparent so OSM base shows through
        e.tile.style.opacity = '0';
      }
    } catch(_) {
      // Make tile transparent on any error
      if (e?.tile) e.tile.style.opacity = '0';
    }
  });
}

if (allowedBases.includes('gbsouth')) {
  gbsouthOverlay = L.tileLayer(LAYERS.gbsouth.url, {
    attribution: LAYERS.gbsouth.attribution,
    maxZoom: 12, // GB South tiles available up to zoom 12
    maxNativeZoom: 12,
    minZoom: 6,  // GB South tiles start at zoom 6
    pane: 'chartsPane'
  });

  // Make tiles transparent on error so OSM base shows through
  gbsouthOverlay.on('tileerror', (e) => {
    if (e?.tile) e.tile.style.opacity = '0';
  });
}

if (allowedBases.includes('ukho')) {
  let ukhoTileErrorCount = 0;
  let ukhoWarnedNoCoverage = false;
  ukhoOverlay = L.tileLayer(LAYERS.ukho.url, {
    attribution: LAYERS.ukho.attribution,
    maxZoom: 18,
    maxNativeZoom: 18,
    pane: 'chartsPane'
  });

  // Make tiles transparent on error so OSM base shows through.
  // Discovery API may return empty/transparent coverage depending on area/entitlement.
  ukhoOverlay.on('tileerror', (e) => {
    if (e?.tile) e.tile.style.opacity = '0';
    ukhoTileErrorCount += 1;
    if (ukhoTileErrorCount >= 6 && !ukhoWarnedNoCoverage && baseSelect.value === 'ukho') {
      ukhoWarnedNoCoverage = true;
      alert('UKHO Discovery has no visible chart data for this area/zoom. Try south coast UK coverage or check /api/ukho/status.');
    }
  });
  ukhoOverlay.on('tileload', () => {
    ukhoTileErrorCount = 0;
  });
}

const osm = layerDefs.osm, esri = layerDefs.esri, topo = null, navigation = null, night = null; // topo, navigation, and night are now vector, handled separately
console.log('[Layer Init] Layer availability:', { osm: !!osm, esri: !!esri, topo: 'vector (handled separately)', navigation: 'vector (handled separately)', night: 'vector (handled separately)', 'allowedBases': allowedBases });
console.log('[Layer Init] User permissions:', { 'user.allowed_bases': user?.allowed_bases, 'rawBases': rawBases });
// Expose refresh function to window for debugging
window.refreshUserPermissions = async () => {
  console.log('[Refresh] Fetching latest user data...');
  try {
    const res = await fetch('/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if (res.ok) {
      const data = await res.json();
      applySessionResponse(data, sessionHooks);
      console.log('[Refresh] ✅ Updated user data:', { 'allowed_bases': user.allowed_bases });
      console.log('[Refresh] ⚠️  You need to RELOAD the page for layer changes to take effect!');
      return user;
    } else {
      console.error('[Refresh] ❌ Failed to fetch user data');
    }
  } catch (e) {
    console.error('[Refresh] ❌ Error:', e);
  }
};

let oceanGlLayer = null;
let oceanGlMap = null;

let topoGlLayer = null;
let topoGlMap = null;

let nightGlLayer = null;
let nightGlMap = null;

let navigationGlLayer = null;
let navigationGlMap = null;

// Topo, navigation, and night are now vector layers, so we initialize with other raster layers
// They will be created via createTopoLayer()/createNavigationLayer()/createNightLayer() when selected
let currentBase = (osm||esri);
let currentOverlay = null; // Track which chart overlay base is active (shom/ukho/gbsouth)
let isNamesOverlayEnabled = false; // Track "Names" labels-only overlay state
let baseSwitchRequestId = 0;

if (currentBase) {
  currentBase.addTo(map);
  const initialBaseType = document.getElementById('baseLayer')?.value || 'osm';
  applyZoomLimitsForBase(initialBaseType);
} else {
  if (!allowedBases.includes('topo') && !allowedBases.includes('navigation') && !allowedBases.includes('night') && !allowedBases.includes('ocean') && !allowedBases.includes('shom') && !allowedBases.includes('ukho') && !allowedBases.includes('gbsouth')) {
    alert('Your account has no base map access. Please contact an administrator.');
  }
}

const seamarks = allowedOver.includes('seamarks') ? L.tileLayer(LAYERS.openseamap.url, {
  attribution: LAYERS.openseamap.attribution,
  maxZoom: 20, opacity: 0.9, pane: 'overlayPane'
}) : null;
let openaipLayer = null;
let namesGlLayer = null;
let namesGlMap = null;

function getNamesVectorStyleUrl() {
  // Prefer explicit names overlay style, fall back to navigation style.
  return LAYERS.names_overlay?.styleUrl || LAYERS.navigation?.styleUrl || null;
}

function buildLabelsOnlyStyle(styleJson) {
  const allLayers = Array.isArray(styleJson?.layers) ? styleJson.layers : [];
  const isRoadLabelLayer = (layer) => {
    const id = (layer?.id || '').toLowerCase();
    const sourceLayer = (layer?.['source-layer'] || '').toLowerCase();
    const textField = String(layer?.layout?.['text-field'] || '').toLowerCase();
    const haystack = `${id} ${sourceLayer}`;
    // Remove all road labels, especially route references like A6/M25.
    if (/road|street|highway|motorway|route|transport|shield|ref/.test(haystack)) return true;
    if (/\{ref\}|road_ref|route_ref/.test(textField)) return true;
    return false;
  };

  const labelLayers = allLayers
    .filter(layer => layer?.type === 'symbol' && layer?.layout && layer.layout['text-field'])
    .filter(layer => !isRoadLabelLayer(layer))
    .map(layer => ({
      ...layer,
      // Force consistent black labels over satellite imagery.
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

async function createNamesOverlayLayer() {
  if (namesGlLayer) return namesGlLayer;

  const styleUrl = getNamesVectorStyleUrl();
  if (!styleUrl) {
    console.warn('[Names] No vector style URL available for labels overlay');
    return null;
  }

  try {
    const styleResponse = await fetch(styleUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!styleResponse.ok) {
      throw new Error(`Failed to fetch names style: ${styleResponse.status}`);
    }

    const fullStyle = absolutizeMapStyleUrls(await styleResponse.json());
    const labelsStyle = buildLabelsOnlyStyle(fullStyle);

    if (!labelsStyle.layers.length) {
      console.warn('[Names] No text symbol layers found in style');
      return null;
    }

    namesGlLayer = L.maplibreGL({
      style: labelsStyle,
      interactive: false,
      pane: 'labelPane',
      transformRequest: makeArcgisTransformRequest(() => localStorage.getItem('token')),
    });

    namesGlMap = namesGlLayer.getMaplibreMap();
    namesGlMap?.on('load', () => {
      console.log('[Names] Vector labels overlay loaded');
    });
    namesGlMap?.on('error', (e) => {
      console.error('[Names] MapLibre GL error:', e?.error || e);
    });

    return namesGlLayer;
  } catch (error) {
    console.error('[Names] Failed to create vector labels overlay:', error);
    return null;
  }
}

function baseHasNames(baseType) {
  return LAYERS[baseType]?.names !== false;
}

function supportsNamesOverlay(baseType) {
  // Labels-only overlay is currently supported for ArcGIS satellite only.
  return baseType === 'esri' && !!getNamesVectorStyleUrl();
}

// Population Density Layer (MapLibre GL)
let densityGlLayer = null;
let densityGlMap = null;
let densityDataState = {
  lad: { loaded: false, data: null, pending: false },
  msoa: { loaded: false, data: null, pending: false },
  oa: { loaded: false, data: null, pending: false }
};
let densityAppliedStates = { lad: new Set(), msoa: new Set(), oa: new Set() };
let densityOpacity = user.density_opacity || 0.65;
let densityBorderColor = user.density_border_color || 'rgba(255,255,255,0.2)';
let densityBorderHoverColor = user.density_border_hover_color || 'rgba(0,0,0,0.9)';
let densityHoveredFeature = null;
const DENSITY_MAX = 15000;

// Ruler units - declared early so applyUserPreferences can access it
let rulerUnits = 'm';
const densityColorStops = [
  0, '#fef9c3',
  100, '#fef08a',
  250, '#fcd34d',
  500, '#fbbf24',
  1000, '#fb923c',
  2500, '#f97316',
  5000, '#dc2626',
  10000, '#991b1b',
  15000, '#7f1d1d'
];

const baseSelect    = document.getElementById('baseLayer');
const seamarksCb    = document.getElementById('seamarks');
const openaipCb     = document.getElementById('openaip');
const densityCb     = document.getElementById('density');
const exportBtn     = document.getElementById('exportBtn');
const hgtBoxBtn     = document.getElementById('hgtBoxBtn');
const exportSystem  = document.getElementById('exportSystem');
const exportQuality = document.getElementById('exportQuality');
const filenameInput = document.getElementById('exportFilename');
const historyToggle = document.getElementById('historyToggle');
const toggleBoxBtn  = document.getElementById('toggleBox');
const topbarEl      = document.querySelector('.topbar');

// Keep map controls aligned under the actual wrapped top bar height.
function syncTopbarHeightVar() {
  if (!topbarEl) return;
  const h = Math.ceil(topbarEl.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--topbar-height', `${h}px`);
}

window.addEventListener('resize', syncTopbarHeightVar);
if (topbarEl) {
  new ResizeObserver(syncTopbarHeightVar).observe(topbarEl);
}
syncTopbarHeightVar();

// Trim UI to allowed layers
function setupUIByPermissions(){
  console.log('[setupUIByPermissions] Starting...', { allowedBases, allowedOver });

  // base select
  const baseOptions = Array.from(baseSelect.querySelectorAll('option'));
  const removedOptions = [];
  baseOptions.forEach(opt=>{
    if(!allowedBases.includes(opt.value)) {
      opt.remove();
      removedOptions.push(opt.value);
    }
  });
  if (removedOptions.length > 0) {
    console.log('[setupUIByPermissions] Removed base options:', removedOptions);
  }

  // ensure valid selection after pruning
  const firstOption = baseSelect.querySelector('option');
  if (firstOption) baseSelect.value = firstOption.value;
  else baseSelect.disabled = true;
  // overlays toggles - hide checkboxes if they exist
  if (!allowedOver.includes('seamarks') && seamarksCb) {
    const label = seamarksCb.closest('label');
    if (label) label.style.display='none';
  }
  if (!allowedOver.includes('openaip') && openaipCb) {
    const label = openaipCb.closest('label');
    if (label) label.style.display='none';
  }
  // Note: label button is an emoji button, not a checkbox, so handle it below
  // Remove emoji buttons for disallowed layers (remove from DOM, not just hide)
  // Map all base button IDs to their permission keys
  const baseButtonMap = {
    'btnOsm': 'osm',
    'btnEsri': 'esri',
    'btnTopo': 'topo',
    'btnNavigation': 'navigation',
    'btnNight': 'night',
    'btnOcean': 'ocean',
    'btnShom': 'shom',
    'btnUkho': 'ukho',
    'btnGbsouth': 'gbsouth'
  };

  // Map all overlay button IDs to their permission keys
  const overlayButtonMap = {
    'btnSeamarks': 'seamarks',
    'btnOpenaip': 'openaip',
    'btnDensity': 'density',
    'btnLabel': 'label',
    'btnHistory': 'history'
  };

  // Remove base map buttons that are not allowed
  const removedBaseButtons = [];
  Object.entries(baseButtonMap).forEach(([btnId, permissionKey]) => {
    if (!allowedBases.includes(permissionKey)) {
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.remove();
        removedBaseButtons.push(btnId);
      }
    }
  });

  // Remove overlay buttons that are not allowed
  const removedOverlayButtons = [];
  Object.entries(overlayButtonMap).forEach(([btnId, permissionKey]) => {
    if (!allowedOver.includes(permissionKey)) {
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.remove();
        removedOverlayButtons.push(btnId);
      }
    }
  });

  if (removedBaseButtons.length > 0) {
    console.log('[setupUIByPermissions] Removed base buttons:', removedBaseButtons);
  }
  if (removedOverlayButtons.length > 0) {
    console.log('[setupUIByPermissions] Removed overlay buttons:', removedOverlayButtons);
  }

  console.log('[setupUIByPermissions] Complete. Buttons removed based on permissions.');
}
setupUIByPermissions();

// Helper functions for base layer handling
function getLayerUrl(baseType) {
  // Ocean is a vector tile layer, not a raster URL
  if (baseType === 'ocean') {
    return null; // Ocean uses MapLibre GL, not a URL
  }
  return LAYERS[baseType]?.url;
}

function getLayerAttribution(baseType) {
  return LAYERS[baseType]?.attribution || '';
}

// Label enhancement for ArcGIS maps
function applyLabelEnhancement() {
  // Resolve pane once and clear any previously applied filter.
  const basePane = map.getPane('basePane');
  if (basePane) basePane.style.filter = '';

  // Check if current base is an ArcGIS map (raster only, not vector)
  const selectedBase = baseSelect.value;
  // Topo, navigation, and night are now vector layers, so exclude them from raster label enhancement
  const isArcGIS = ['esri'].includes(selectedBase);

  if (!isArcGIS) return; // Only enhance ArcGIS raster maps

  // Get current zoom level
  const zoom = map.getZoom();

  // Calculate adaptive filter strength based on zoom
  // Lower zoom = stronger enhancement (labels are smaller and harder to read)
  let contrast, brightness;
  if (zoom <= 5) {
    contrast = 1.15;  // Strong contrast boost at low zoom
    brightness = 1.08;
  } else if (zoom <= 10) {
    contrast = 1.10;  // Moderate enhancement at medium zoom
    brightness = 1.05;
  } else {
    contrast = 1.05;  // Subtle enhancement at high zoom
    brightness = 1.02;
  }

  // Apply filter at the pane level so it moves as a single compositing unit
  // with the CSS transform during panning, keeping it in sync with overlays.
  // Per-img filters break GPU-accelerated panning and cause visual desync.
  if (basePane) {
    basePane.style.filter = `contrast(${contrast}) brightness(${brightness})`;
  }
}

function updateLabelButtonVisibility() {
  // Show "Names" button only when:
  // 1) User has overlay permission
  // 2) Current base does NOT already include names
  // 3) We support labels-only overlay for this base
  const selectedBase = baseSelect.value;
  const shouldShow = allowedOver.includes('label') && !baseHasNames(selectedBase) && supportsNamesOverlay(selectedBase);
  const btn = document.getElementById('btnLabel');

  if (btn) {
    if (shouldShow) {
      btn.style.display = '';
    } else {
      btn.style.display = 'none';
      if (isNamesOverlayEnabled) {
        isNamesOverlayEnabled = false;
        if (namesGlLayer && map.hasLayer(namesGlLayer)) map.removeLayer(namesGlLayer);
      }
    }
  }

}

async function applyNamesOverlayForBase(baseType) {
  const canShowNames = supportsNamesOverlay(baseType) && !baseHasNames(baseType);
  if (isNamesOverlayEnabled && canShowNames) {
    const layer = await createNamesOverlayLayer();
    if (layer && !map.hasLayer(layer)) {
      layer.addTo(map);
    }
  } else {
    if (namesGlLayer && map.hasLayer(namesGlLayer)) map.removeLayer(namesGlLayer);
  }
}

async function refreshBaseLayer() {
  const baseType = baseSelect.value;

  // Remove current base
  if (currentBase && currentBase.remove) {
    map.removeLayer(currentBase);
  }
  removeOceanLayer();
  removeTopoLayer();
  removeNightLayer();
  removeNavigationLayer();

  // Handle ocean (vector tile layer)
  if (baseType === 'ocean') {
    currentBase = await createOceanLayer();
    if (!currentBase) {
      console.warn('[Ocean] Failed to load ocean layer');
      return;
    }
  }
  // Handle topo (vector tile layer)
  else if (baseType === 'topo') {
    currentBase = await createTopoLayer();
    if (!currentBase) {
      console.warn('[Topo] Failed to load topo layer');
      return;
    }
  }
  // Handle night (vector tile layer)
  else if (baseType === 'night') {
    currentBase = await createNightLayer();
    if (!currentBase) {
      console.warn('[Night] Failed to load night layer');
      return;
    }
  }
  // Handle navigation (vector tile layer)
  else if (baseType === 'navigation') {
    currentBase = await createNavigationLayer();
    if (!currentBase) {
      console.warn('[Navigation] Failed to load navigation layer');
      return;
    }
  } else {
    // Get the appropriate URL based on labeled mode
    const url = getLayerUrl(baseType);
    if (!url) {
      console.warn(`[Labeled Map] No layer available for: ${baseType}`);
      return;
    }

    // Create new layer with correct URL
    currentBase = createBaseRasterLayer(baseType, url, getLayerAttribution(baseType));

    currentBase.addTo(map);
  }

  // Re-add overlays
  if (seamarksCb.checked && seamarks) seamarks.addTo(map).bringToFront();
  if (openaipCb.checked && openaipLayer) openaipLayer.addTo(map).bringToFront();
  applyNamesOverlayForBase(baseType);

  // Apply label enhancement for ArcGIS raster map
  if (baseType === 'esri') {
    applyLabelEnhancement();
  }

  setAttrib();
}

const toolbarController = createToolbarController({
  baseSelect,
  seamarksCb,
  openaipCb,
  densityCb,
  historyToggle,
  allowedBases,
  allowedOver,
  applyNamesOverlayForBase,
  setAttrib,
  updateLabelButtonVisibility,
  getIsNamesOverlayEnabled: () => isNamesOverlayEnabled,
  setIsNamesOverlayEnabled: (next) => { isNamesOverlayEnabled = next; },
});
const {
  updateBaseButtonStates,
  updateOverlayButtonStates,
  updateMoreButtonsHighlight,
  applyFavorites,
  applyToolbarOverflowLayout,
  populateFavoriteSelects,
  loadFavorites,
} = toolbarController;
toolbarController.init();

// Apply saved user preferences
async function applyUserPreferences() {
  // Apply base layer preference if set
  if (user.default_base && allowedBases.includes(user.default_base)) {
    const requestId = ++baseSwitchRequestId;
    const isStaleRequest = () => requestId !== baseSwitchRequestId;
    baseSelect.value = user.default_base;
    // Switch to the preferred base layer
    const selectedBase = user.default_base;
    let activeBaseType = selectedBase;

    // Remove current layers
    if (currentBase) map.removeLayer(currentBase);
    if (currentOverlay) map.removeLayer(currentOverlay);

    // Handle SHOM: OSM base + SHOM overlay
    if (selectedBase === 'shom' && shomOverlay) {
      removeOceanLayer();
      removeTopoLayer();
      removeNightLayer();
      removeNavigationLayer();
      const baseUrl = LAYERS.osm.url;
      const baseAttrib = LAYERS.osm.attribution;
      currentBase = createBaseRasterLayer('osm', baseUrl, baseAttrib);
      currentOverlay = shomOverlay;
      currentBase.addTo(map);
      currentOverlay.addTo(map);
    }
    // Handle gbsouth: OSM base + gbsouth overlay
    else if (selectedBase === 'gbsouth' && gbsouthOverlay) {
      removeOceanLayer();
      removeTopoLayer();
      removeNightLayer();
      removeNavigationLayer();
      const baseUrl = LAYERS.osm.url;
      const baseAttrib = LAYERS.osm.attribution;
      currentBase = createBaseRasterLayer('osm', baseUrl, baseAttrib);
      currentOverlay = gbsouthOverlay;
      currentBase.addTo(map);
      currentOverlay.addTo(map);
    }
    // Handle UKHO: OSM base + UKHO chart overlay
    else if (selectedBase === 'ukho' && ukhoOverlay) {
      removeOceanLayer();
      removeTopoLayer();
      removeNightLayer();
      removeNavigationLayer();
      const baseUrl = LAYERS.osm.url;
      const baseAttrib = LAYERS.osm.attribution;
      currentBase = createBaseRasterLayer('osm', baseUrl, baseAttrib);
      currentOverlay = ukhoOverlay;
      currentBase.addTo(map);
      currentOverlay.addTo(map);
    }
    // Handle OCEAN: vector tile layer (MapLibre GL)
    else if (selectedBase === 'ocean') {
      if (currentBase && currentBase.remove) {
        map.removeLayer(currentBase);
      }
      removeOceanLayer();
      removeTopoLayer();
      currentBase = await createOceanLayer();
      if (isStaleRequest()) return;
      if (!currentBase) {
        currentBase = osm || layerDefs.osm;
        if (currentBase) currentBase.addTo(map);
        activeBaseType = 'osm';
      }
      currentOverlay = null;
    }
    // Handle TOPO: vector tile layer (MapLibre GL)
    else if (selectedBase === 'topo') {
      if (currentBase && currentBase.remove) {
        map.removeLayer(currentBase);
      }
      removeOceanLayer();
      removeTopoLayer();
      removeNightLayer();
      currentBase = await createTopoLayer();
      if (isStaleRequest()) return;
      if (!currentBase) {
        currentBase = osm || layerDefs.osm;
        if (currentBase) currentBase.addTo(map);
        activeBaseType = 'osm';
      }
      currentOverlay = null;
    }
    // Handle NIGHT: vector tile layer (MapLibre GL)
    else if (selectedBase === 'night') {
      if (currentBase && currentBase.remove) {
        map.removeLayer(currentBase);
      }
      removeOceanLayer();
      removeTopoLayer();
      removeNightLayer();
      removeNavigationLayer();
      currentBase = await createNightLayer();
      if (isStaleRequest()) return;
      if (!currentBase) {
        currentBase = osm || layerDefs.osm;
        if (currentBase) currentBase.addTo(map);
        activeBaseType = 'osm';
      }
      currentOverlay = null;
    }
    // Handle NAVIGATION: vector tile layer (MapLibre GL)
    else if (selectedBase === 'navigation') {
      if (currentBase && currentBase.remove) {
        map.removeLayer(currentBase);
      }
      removeOceanLayer();
      removeTopoLayer();
      removeNightLayer();
      removeNavigationLayer();
      currentBase = await createNavigationLayer();
      if (isStaleRequest()) return;
      if (!currentBase) {
        currentBase = osm || layerDefs.osm;
        if (currentBase) currentBase.addTo(map);
        activeBaseType = 'osm';
      }
      currentOverlay = null;
    }
    // Handle OSM or ESRI: pure base layers (raster)
    else {
      removeOceanLayer();
      removeTopoLayer();
      removeNightLayer();
      removeNavigationLayer();
      const url = getLayerUrl(selectedBase);
      const attrib = getLayerAttribution(selectedBase);
      if (url) {
        currentBase = createBaseRasterLayer(selectedBase, url, attrib);
        currentBase.addTo(map);
      } else {
        console.warn(`[Base Layer] Missing URL for "${selectedBase}", falling back to OSM.`);
        currentBase = osm || layerDefs.osm;
        if (currentBase) currentBase.addTo(map);
        activeBaseType = 'osm';
      }
      currentOverlay = null;
    }
    if (isStaleRequest()) return;
    applyZoomLimitsForBase(activeBaseType);
    await applyNamesOverlayForBase(selectedBase);
    if (isStaleRequest()) return;
  }

  // Apply overlay preferences if set
  if (user.default_overlays && Array.isArray(user.default_overlays)) {
    if (user.default_overlays.includes('seamarks') && seamarks && allowedOver.includes('seamarks')) {
      seamarksCb.checked = true;
      seamarks.addTo(map).bringToFront();
    }
    if (user.default_overlays.includes('openaip') && LAYERS.openaip?.url && allowedOver.includes('openaip')) {
      openaipCb.checked = true;
      // Create the layer directly since event listeners aren't attached yet
      openaipLayer = L.tileLayer(LAYERS.openaip.url, {
        attribution: LAYERS.openaip.attribution,
        maxZoom: 20, opacity: 0.9, pane: 'overlayPane'
      }).addTo(map).bringToFront();
    }
    // Density will be applied later after createDensityLayer is defined
    if (user.default_overlays.includes('density') && LAYERS.density && allowedOver.includes('density')) {
      densityCb.checked = true;
    }
    if (user.default_overlays.includes('label') && allowedOver.includes('label')) {
      isNamesOverlayEnabled = true;
    }
    if (user.default_overlays.includes('history') && allowedOver.includes('history')) {
      historyToggle.checked = true;
      exportHistory.addTo(map);
    } else {
      historyToggle.checked = false;
      map.removeLayer(exportHistory);
    }
  }

  // Apply ruler unit preference
  if (user.default_units) {
    rulerUnits = user.default_units;
  }

  // Apply export system preference if set (for hidden select)
  if (user.default_system) {
    exportSystem.value = user.default_system;
  }

  // Apply export quality preference if set (for hidden select)
  if (user.default_quality) {
    exportQuality.value = user.default_quality;
  }

  // Update button states to match loaded preferences
  updateBaseButtonStates();
  updateOverlayButtonStates();
  updateLabelButtonVisibility(); // Show/hide label button based on selected map
  applyLabelEnhancement(); // Apply label enhancement for ArcGIS maps

  // Update attributions after applying preferences
  setAttrib();

  // Load export attribution setting from localStorage
  const savedExportAttr = localStorage.getItem('scepmaps_export_attribution');
  const exportAttrCheckbox = document.getElementById('exportAttribution');
  if (exportAttrCheckbox) {
    exportAttrCheckbox.checked = savedExportAttr !== 'false'; // default to true
  }
}
applyUserPreferences();

// no width input anymore; computed on click depending on system

function setAttrib(){
  const a = [];
  const base = baseSelect.value;

  // Simple if/else to get attribution
  const attrib = getLayerAttribution(base);
  if (attrib) a.push(attrib);

  if (seamarksCb.checked && LAYERS.openseamap) a.push(LAYERS.openseamap.attribution);
  if (openaipCb.checked && LAYERS.openaip) a.push(LAYERS.openaip.attribution);
  if (isNamesOverlayEnabled && supportsNamesOverlay(base) && !baseHasNames(base) && LAYERS.names_overlay) {
    a.push(LAYERS.names_overlay.attribution);
  }
  if (densityCb.checked && LAYERS.density) a.push(LAYERS.density.attribution);
  document.getElementById('attrib').innerHTML = a.join(' | ');

  // Also update Leaflet's built-in attribution with all attributions
  const leafletAttrib = document.querySelector('.leaflet-control-attribution');
  if (leafletAttrib) {
    // Build full attribution string
    const fullAttrib = a.filter(attr => attr).join(' | ');
    // Keep Leaflet link if present
    const leafletLink = leafletAttrib.innerHTML.includes('Leaflet')
      ? '<a href="https://leafletjs.com" title="A JavaScript library for interactive maps">Leaflet</a>'
      : '';
    leafletAttrib.innerHTML = fullAttrib + (leafletLink ? ' | ' + leafletLink : '');
  }
}

baseSelect.addEventListener('change', async () => {
  const requestId = ++baseSwitchRequestId;
  const isStaleRequest = () => requestId !== baseSwitchRequestId;
  const selectedBase = baseSelect.value;
  let activeBaseType = selectedBase;

  // Remove current layers
  if (currentBase) map.removeLayer(currentBase);
  if (currentOverlay) map.removeLayer(currentOverlay);

  // Handle SHOM: OSM base + SHOM overlay
  if (selectedBase === 'shom' && shomOverlay) {
    // Chart overlays sit on OSM — clear any leftover MapLibre vector basemap first.
    removeOceanLayer();
    removeTopoLayer();
    removeNightLayer();
    removeNavigationLayer();
    // SHOM uses OSM underlay
    const baseUrl = LAYERS.osm.url;
    const baseAttrib = LAYERS.osm.attribution;
    currentBase = createBaseRasterLayer('osm', baseUrl, baseAttrib);
    currentOverlay = shomOverlay;
    currentBase.addTo(map);
    currentOverlay.addTo(map);
  }
  // Handle gbsouth: OSM base + gbsouth overlay
  else if (selectedBase === 'gbsouth' && gbsouthOverlay) {
    removeOceanLayer();
    removeTopoLayer();
    removeNightLayer();
    removeNavigationLayer();
    // GB South uses OSM underlay
    const baseUrl = LAYERS.osm.url;
    const baseAttrib = LAYERS.osm.attribution;
    currentBase = createBaseRasterLayer('osm', baseUrl, baseAttrib);
    currentOverlay = gbsouthOverlay;
    currentBase.addTo(map);
    currentOverlay.addTo(map);
  }
  // Handle UKHO: OSM base + UKHO chart overlay
  else if (selectedBase === 'ukho' && ukhoOverlay) {
    removeOceanLayer();
    removeTopoLayer();
    removeNightLayer();
    removeNavigationLayer();
    const baseUrl = LAYERS.osm.url;
    const baseAttrib = LAYERS.osm.attribution;
    currentBase = createBaseRasterLayer('osm', baseUrl, baseAttrib);
    currentOverlay = ukhoOverlay;
    currentBase.addTo(map);
    currentOverlay.addTo(map);
  }
  // Handle OCEAN: vector tile layer (MapLibre GL)
  else if (selectedBase === 'ocean') {
    // Remove any existing base layers
    if (currentBase && currentBase.remove) {
      map.removeLayer(currentBase);
    }
    removeOceanLayer();
    removeTopoLayer();

    // Create ocean vector tile layer
    currentBase = await createOceanLayer();
    if (isStaleRequest()) return;
    if (!currentBase) {
      // Fallback to OSM if ocean fails
      console.warn('[Ocean] Failed to load ocean layer, falling back to OSM');
      currentBase = osm || layerDefs.osm;
      if (currentBase) currentBase.addTo(map);
      activeBaseType = 'osm';
    }
    currentOverlay = null;
  }
  // Handle TOPO: vector tile layer (MapLibre GL)
  else if (selectedBase === 'topo') {
    // Remove any existing base layers
    if (currentBase && currentBase.remove) {
      map.removeLayer(currentBase);
    }
    removeOceanLayer();
    removeTopoLayer();
    removeNightLayer();

    // Create topo vector tile layer
    currentBase = await createTopoLayer();
    if (isStaleRequest()) return;
    if (!currentBase) {
      // Fallback to OSM if topo fails
      console.warn('[Topo] Failed to load topo layer, falling back to OSM');
      currentBase = osm || layerDefs.osm;
      if (currentBase) currentBase.addTo(map);
      activeBaseType = 'osm';
    }
    currentOverlay = null;
  }
  // Handle NIGHT: vector tile layer (MapLibre GL)
  else if (selectedBase === 'night') {
    // Remove any existing base layers
    if (currentBase && currentBase.remove) {
      map.removeLayer(currentBase);
    }
    removeOceanLayer();
    removeTopoLayer();
    removeNightLayer();
    removeNavigationLayer();

    // Create night vector tile layer
    currentBase = await createNightLayer();
    if (isStaleRequest()) return;
    if (!currentBase) {
      // Fallback to OSM if night fails
      console.warn('[Night] Failed to load night layer, falling back to OSM');
      currentBase = osm || layerDefs.osm;
      if (currentBase) currentBase.addTo(map);
      activeBaseType = 'osm';
    }
    currentOverlay = null;
  }
  // Handle NAVIGATION: vector tile layer (MapLibre GL)
  else if (selectedBase === 'navigation') {
    // Remove any existing base layers
    if (currentBase && currentBase.remove) {
      map.removeLayer(currentBase);
    }
    removeOceanLayer();
    removeTopoLayer();
    removeNightLayer();
    removeNavigationLayer();

    // Create navigation vector tile layer
    currentBase = await createNavigationLayer();
    if (isStaleRequest()) return;
    if (!currentBase) {
      // Fallback to OSM if navigation fails
      console.warn('[Navigation] Failed to load navigation layer, falling back to OSM');
      currentBase = osm || layerDefs.osm;
      if (currentBase) currentBase.addTo(map);
      activeBaseType = 'osm';
    }
    currentOverlay = null;
  }
  // Handle OSM or ESRI: pure base layers (raster)
  else {
    // Remove vector layers if they exist
    removeOceanLayer();
    removeTopoLayer();
    removeNightLayer();
    removeNavigationLayer();

    const url = getLayerUrl(selectedBase);
    const attrib = getLayerAttribution(selectedBase);
    if (url) {
      currentBase = createBaseRasterLayer(selectedBase, url, attrib);
      currentBase.addTo(map);
    } else {
      console.warn(`[Base Layer] Missing URL for "${selectedBase}", falling back to OSM.`);
      currentBase = osm || layerDefs.osm;
      if (currentBase) currentBase.addTo(map);
      activeBaseType = 'osm';
    }
    currentOverlay = null;
  }
  if (isStaleRequest()) return;
  applyZoomLimitsForBase(activeBaseType);

  // Re-add other overlays on top
  if (seamarksCb.checked && seamarks) seamarks.addTo(map).bringToFront();
  if (openaipCb.checked && openaipLayer) openaipLayer.addTo(map).bringToFront();
  await applyNamesOverlayForBase(selectedBase);
  if (isStaleRequest()) return;

  // Update button states
  updateBaseButtonStates();
  updateLabelButtonVisibility(); // Show/hide label button based on selected map
  applyLabelEnhancement(); // Apply label enhancement for ArcGIS maps
  setAttrib();
});

initZoomMechanics(map, {
  onViewportSettled: () => {
    applyLabelEnhancement();
    refreshHgtControlButton();
  }
});

seamarksCb.addEventListener('change', () => {
  if (!seamarks) { seamarksCb.checked = false; return; }
  if (seamarksCb.checked) { seamarks.addTo(map).bringToFront(); }
  else { map.removeLayer(seamarks); }
  setAttrib();
});

openaipCb.addEventListener('change', () => {
  if (openaipCb.checked) {
    if (!LAYERS.openaip.url || !allowedOver.includes('openaip')) {
      alert('OpenAIP URL not configured.');
      openaipCb.checked = false; return;
    }
    openaipLayer = L.tileLayer(LAYERS.openaip.url, {
      attribution: LAYERS.openaip.attribution,
      maxZoom: 20, opacity: 0.9, pane: 'overlayPane'
    }).addTo(map).bringToFront();
  } else if (openaipLayer) {
    map.removeLayer(openaipLayer); openaipLayer = null;
  }
  setAttrib();
});

// --- Ocean Vector Tile Layer (MapLibre GL) ---
async function createOceanLayer() {
  if (oceanGlLayer) {
    // Already created, just return
    return oceanGlLayer;
  }

  if (!LAYERS.ocean || !LAYERS.ocean.styleUrl) {
    console.error('[Ocean] Ocean layer not configured');
    return null;
  }

  try {
    // Fetch the style JSON from backend
    const styleResponse = await fetch(LAYERS.ocean.styleUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!styleResponse.ok) {
      throw new Error(`Failed to fetch ocean style: ${styleResponse.status}`);
    }

    const styleJson = absolutizeMapStyleUrls(await styleResponse.json());

    // Create MapLibre GL layer with the style
    oceanGlLayer = L.maplibreGL({
      style: styleJson,
      interactive: true,
      pane: 'basePane',
      transformRequest: makeArcgisTransformRequest(() => localStorage.getItem('token')),
    }).addTo(map);

    oceanGlMap = oceanGlLayer.getMaplibreMap();

    oceanGlMap.on('load', () => {
      console.log('[Ocean] Ocean vector tile layer loaded');
    });

    oceanGlMap.on('error', (e) => {
      console.error('[Ocean] MapLibre GL error:', e?.error || e);
    });

    return oceanGlLayer;
  } catch (error) {
    console.error('[Ocean] Failed to create ocean layer:', error);
    return null;
  }
}

function removeOceanLayer() {
  if (oceanGlLayer) {
    map.removeLayer(oceanGlLayer);
    oceanGlLayer = null;
    oceanGlMap = null;
  }
}

// --- Topo Vector Tile Layer (MapLibre GL) ---
async function createTopoLayer() {
  if (topoGlLayer) {
    // Already created, just return
    return topoGlLayer;
  }

  if (!LAYERS.topo || !LAYERS.topo.styleUrl) {
    console.error('[Topo] Topo layer not configured');
    return null;
  }

  try {
    // Fetch the style JSON from backend
    const styleResponse = await fetch(LAYERS.topo.styleUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!styleResponse.ok) {
      throw new Error(`Failed to fetch topo style: ${styleResponse.status}`);
    }

    const styleJson = absolutizeMapStyleUrls(await styleResponse.json());

    // Create MapLibre GL layer with the style
    topoGlLayer = L.maplibreGL({
      style: styleJson,
      interactive: true,
      pane: 'basePane',
      transformRequest: makeArcgisTransformRequest(() => localStorage.getItem('token')),
    }).addTo(map);

    topoGlMap = topoGlLayer.getMaplibreMap();

    topoGlMap.on('load', () => {
      console.log('[Topo] Topo vector tile layer loaded');
    });

    topoGlMap.on('error', (e) => {
      console.error('[Topo] MapLibre GL error:', e?.error || e);
    });

    return topoGlLayer;
  } catch (error) {
    console.error('[Topo] Failed to create topo layer:', error);
    return null;
  }
}

function removeTopoLayer() {
  if (topoGlLayer) {
    map.removeLayer(topoGlLayer);
    topoGlLayer = null;
    topoGlMap = null;
  }
}

// --- Night Vector Tile Layer (MapLibre GL) ---
async function createNightLayer() {
  if (nightGlLayer) {
    // Already created, just return
    return nightGlLayer;
  }

  if (!LAYERS.night || !LAYERS.night.styleUrl) {
    console.error('[Night] Night layer not configured');
    return null;
  }

  try {
    // Fetch the style JSON from backend
    const styleResponse = await fetch(LAYERS.night.styleUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!styleResponse.ok) {
      throw new Error(`Failed to fetch night style: ${styleResponse.status}`);
    }

    const styleJson = absolutizeMapStyleUrls(await styleResponse.json());

    // Create MapLibre GL layer with the style
    nightGlLayer = L.maplibreGL({
      style: styleJson,
      interactive: true,
      pane: 'basePane',
      transformRequest: makeArcgisTransformRequest(() => localStorage.getItem('token')),
    }).addTo(map);

    nightGlMap = nightGlLayer.getMaplibreMap();

    nightGlMap.on('load', () => {
      console.log('[Night] Night vector tile layer loaded');
    });

    nightGlMap.on('error', (e) => {
      console.error('[Night] MapLibre GL error:', e?.error || e);
    });

    return nightGlLayer;
  } catch (error) {
    console.error('[Night] Failed to create night layer:', error);
    return null;
  }
}

function removeNightLayer() {
  if (nightGlLayer) {
    map.removeLayer(nightGlLayer);
    nightGlLayer = null;
    nightGlMap = null;
  }
}

// --- Navigation Vector Tile Layer (MapLibre GL) ---
async function createNavigationLayer() {
  if (navigationGlLayer) {
    // Already created, just return
    return navigationGlLayer;
  }

  if (!LAYERS.navigation || !LAYERS.navigation.styleUrl) {
    console.error('[Navigation] Navigation layer not configured');
    return null;
  }

  try {
    // Fetch the style JSON from backend
    const styleResponse = await fetch(LAYERS.navigation.styleUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!styleResponse.ok) {
      throw new Error(`Failed to fetch navigation style: ${styleResponse.status}`);
    }

    const styleJson = absolutizeMapStyleUrls(await styleResponse.json());

    // Create MapLibre GL layer with the style
    navigationGlLayer = L.maplibreGL({
      style: styleJson,
      interactive: true,
      pane: 'basePane',
      transformRequest: makeArcgisTransformRequest(() => localStorage.getItem('token')),
    }).addTo(map);

    navigationGlMap = navigationGlLayer.getMaplibreMap();

    navigationGlMap.on('load', () => {
      console.log('[Navigation] Navigation vector tile layer loaded');
    });

    navigationGlMap.on('error', (e) => {
      console.error('[Navigation] MapLibre GL error:', e?.error || e);
    });

    return navigationGlLayer;
  } catch (error) {
    console.error('[Navigation] Failed to create navigation layer:', error);
    return null;
  }
}

function removeNavigationLayer() {
  if (navigationGlLayer) {
    map.removeLayer(navigationGlLayer);
    navigationGlLayer = null;
    navigationGlMap = null;
  }
}

// --- Population Density Layer (MapLibre GL) ---
async function loadDensityData(level) {
  if (densityDataState[level].loaded || densityDataState[level].pending) return densityDataState[level].data;
  densityDataState[level].pending = true;
  try {
    const response = await fetch(`${LAYERS.density.dataUrl}/density_${level}.json`);
    densityDataState[level].data = await response.json();
    densityDataState[level].loaded = true;
    console.log(`Loaded ${Object.keys(densityDataState[level].data).length} ${level.toUpperCase()} density records`);
    return densityDataState[level].data;
  } catch (e) {
    console.error(`Failed to load density ${level}:`, e);
    densityDataState[level].pending = false;
    return null;
  }
}

function applyDensityStates(glMap, source, sourceLayer, densityData) {
  if (!densityData || !glMap) return;
  const features = glMap.querySourceFeatures(source, { sourceLayer });
  let applied = 0;
  for (const feature of features) {
    const id = feature.properties.areacd;
    if (!id || densityAppliedStates[source].has(id)) continue;
    const density = densityData[id];
    if (density !== undefined) {
      glMap.setFeatureState({ source, sourceLayer, id }, { density });
      densityAppliedStates[source].add(id);
      applied++;
    }
  }
  if (applied > 0) console.log(`Applied ${applied} ${source} density states`);
}

async function handleDensityZoomChange() {
  if (!densityGlMap) return;
  const zoom = densityGlMap.getZoom();
  // Always load LAD
  if (!densityDataState.lad.loaded && !densityDataState.lad.pending) {
    await loadDensityData('lad');
  }
  // Load MSOA at z7+
  if (zoom >= 7 && !densityDataState.msoa.loaded && !densityDataState.msoa.pending) {
    await loadDensityData('msoa');
  }
  // Load OA at z10+
  if (zoom >= 10 && !densityDataState.oa.loaded && !densityDataState.oa.pending) {
    await loadDensityData('oa');
  }
  // Apply states
  requestAnimationFrame(() => {
    if (densityDataState.lad.data) applyDensityStates(densityGlMap, 'lad', 'lad', densityDataState.lad.data);
    if (densityDataState.msoa.data) applyDensityStates(densityGlMap, 'msoa', 'msoa', densityDataState.msoa.data);
    if (densityDataState.oa.data) applyDensityStates(densityGlMap, 'oa', 'oa', densityDataState.oa.data);
  });
}

function createDensityLayer() {
  const glStyle = {
    version: 8,
    sources: {
      'lad': {
        type: 'vector',
        tiles: [LAYERS.density.sources.lad],
        minzoom: 4, maxzoom: 12,
        promoteId: 'areacd'
      },
      'msoa': {
        type: 'vector',
        tiles: [LAYERS.density.sources.msoa],
        minzoom: 4, maxzoom: 12,
        promoteId: 'areacd'
      },
      'oa': {
        type: 'vector',
        tiles: [LAYERS.density.sources.oa],
        minzoom: 4, maxzoom: 12,
        promoteId: 'areacd'
      }
    },
    layers: [
      // LAD (z0-7)
      {
        id: 'lad-fill',
        type: 'fill',
        source: 'lad',
        'source-layer': 'lad',
        minzoom: 0,
        maxzoom: 8,
        paint: {
          'fill-color': [
            'case',
            ['!=', ['feature-state', 'density'], null],
            ['interpolate', ['linear'], ['feature-state', 'density'], ...densityColorStops],
            'transparent'
          ],
          'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], densityOpacity + 0.2, densityOpacity]
        }
      },
      {
        id: 'lad-line',
        type: 'line',
        source: 'lad',
        'source-layer': 'lad',
        minzoom: 0,
        maxzoom: 8,
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], densityBorderHoverColor, densityBorderColor],
          'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2, 1]
        }
      },
      // MSOA (z8-10)
      {
        id: 'msoa-fill',
        type: 'fill',
        source: 'msoa',
        'source-layer': 'msoa',
        minzoom: 8,
        maxzoom: 11,
        paint: {
          'fill-color': [
            'case',
            ['!=', ['feature-state', 'density'], null],
            ['interpolate', ['linear'], ['feature-state', 'density'], ...densityColorStops],
            'transparent'
          ],
          'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], densityOpacity + 0.2, densityOpacity]
        }
      },
      {
        id: 'msoa-line',
        type: 'line',
        source: 'msoa',
        'source-layer': 'msoa',
        minzoom: 8,
        maxzoom: 11,
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], densityBorderHoverColor, densityBorderColor],
          'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2, 0.5]
        }
      },
      // OA (z11+)
      {
        id: 'oa-fill',
        type: 'fill',
        source: 'oa',
        'source-layer': 'oa',
        minzoom: 11,
        maxzoom: 22,
        paint: {
          'fill-color': [
            'case',
            ['!=', ['feature-state', 'density'], null],
            ['interpolate', ['linear'], ['feature-state', 'density'], ...densityColorStops],
            'transparent'
          ],
          'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], densityOpacity + 0.2, densityOpacity]
        }
      },
      {
        id: 'oa-line',
        type: 'line',
        source: 'oa',
        'source-layer': 'oa',
        minzoom: 11,
        maxzoom: 22,
        paint: {
          'line-color': ['case', ['boolean', ['feature-state', 'hover'], false], densityBorderHoverColor, densityBorderColor],
          'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 2, 0.5]
        }
      }
    ]
  };

  densityGlLayer = L.maplibreGL({
    style: glStyle,
    interactive: true,
    pane: 'densityPane'
  }).addTo(map);

  densityGlMap = densityGlLayer.getMaplibreMap();
  densityGlMap.on('load', async () => {
    await handleDensityZoomChange();
    densityGlMap.on('sourcedata', (e) => {
      if (e.isSourceLoaded && ['lad', 'msoa', 'oa'].includes(e.sourceId)) {
        const data = densityDataState[e.sourceId].data;
        if (data) applyDensityStates(densityGlMap, e.sourceId, e.sourceId, data);
      }
    });
    densityGlMap.on('zoomend', handleDensityZoomChange);
    densityGlMap.on('moveend', handleDensityZoomChange);

    // Hover interactions
    ['lad-fill', 'msoa-fill', 'oa-fill'].forEach(layerId => {
      const source = layerId.replace('-fill', '');

      densityGlMap.on('mousemove', layerId, (e) => {
        if (e.features.length === 0) return;
        if (!(isRulerActive || isDrawingBox)) {
          densityGlMap.getCanvas().style.cursor = 'pointer';
        }

        const feature = e.features[0];
        const id = feature.properties.areacd;

        // Clear previous hover
        if (densityHoveredFeature && densityHoveredFeature.id !== id) {
          densityGlMap.setFeatureState(
            { source: densityHoveredFeature.source, sourceLayer: densityHoveredFeature.source, id: densityHoveredFeature.id },
            { hover: false }
          );
        }

        // Set new hover
        densityHoveredFeature = { id, source };
        densityGlMap.setFeatureState(
          { source, sourceLayer: source, id },
          { hover: true }
        );

        // Update density legend with hover info
        const density = densityDataState[source].data?.[id];
        showDensityHoverInfo(feature.properties, density);
      });

      densityGlMap.on('mouseleave', layerId, () => {
        if (!(isRulerActive || isDrawingBox)) {
          densityGlMap.getCanvas().style.cursor = '';
        }

        if (densityHoveredFeature) {
          densityGlMap.setFeatureState(
            { source: densityHoveredFeature.source, sourceLayer: densityHoveredFeature.source, id: densityHoveredFeature.id },
            { hover: false }
          );
          densityHoveredFeature = null;
        }

        hideDensityHoverInfo();
      });
    });
  });
}

function densityToPercent(density) {
  if (density == null || density <= 0) return 0;
  if (density >= DENSITY_MAX) return 100;
  // Use logarithmic scale for better distribution
  const logMax = Math.log(DENSITY_MAX);
  const logVal = Math.log(Math.max(1, density));
  return (logVal / logMax) * 100;
}

function showDensityHoverInfo(props, density) {
  const name = props.areanm || props.hclnm || props.areacd;
  document.getElementById('densityAreaName').textContent = name;
  document.getElementById('densityAreaCode').textContent = props.areacd;
  document.getElementById('densityValueDisplay').textContent =
    density != null ? Math.round(density).toLocaleString() : 'N/A';

  // Position marker on gradient
  const percent = densityToPercent(density);
  const marker = document.getElementById('densityMarker');
  marker.style.left = percent + '%';

  // Show hover info, hide default title
  document.getElementById('densityDefaultTitle').classList.add('hidden');
  document.getElementById('densityHoverInfo').classList.add('visible');
  marker.classList.add('visible');
}

function hideDensityHoverInfo() {
  document.getElementById('densityHoverInfo').classList.remove('visible');
  document.getElementById('densityMarker').classList.remove('visible');
  document.getElementById('densityDefaultTitle').classList.remove('hidden');
}

function removeDensityLayer() {
  if (densityGlLayer) {
    map.removeLayer(densityGlLayer);
    densityGlLayer = null;
    densityGlMap = null;
    densityHoveredFeature = null;
    // Reset applied states for next activation
    densityAppliedStates = { lad: new Set(), msoa: new Set(), oa: new Set() };
    // Hide hover info
    hideDensityHoverInfo();
  }
}

function updateDensityOpacity(opacity) {
  densityOpacity = opacity;
  if (densityGlMap) {
    ['lad-fill', 'msoa-fill', 'oa-fill'].forEach(layerId => {
      if (densityGlMap.getLayer(layerId)) {
        densityGlMap.setPaintProperty(layerId, 'fill-opacity',
          ['case', ['boolean', ['feature-state', 'hover'], false], opacity + 0.2, opacity]
        );
      }
    });
  }
}

function updateDensityBorderColors(borderColor, hoverColor) {
  densityBorderColor = borderColor;
  densityBorderHoverColor = hoverColor;
  if (densityGlMap) {
    ['lad-line', 'msoa-line', 'oa-line'].forEach(layerId => {
      if (densityGlMap.getLayer(layerId)) {
        densityGlMap.setPaintProperty(layerId, 'line-color',
          ['case', ['boolean', ['feature-state', 'hover'], false], hoverColor, borderColor]
        );
      }
    });
  }
}

densityCb.addEventListener('change', () => {
  if (densityCb.checked) {
    createDensityLayer();
    document.getElementById('densityLegend').classList.add('visible');
  } else {
    removeDensityLayer();
    document.getElementById('densityLegend').classList.remove('visible');
  }
  setAttrib();
});

// Apply deferred density overlay if it was set in preferences (after function is defined)
if (densityCb.checked && !densityGlLayer) {
  createDensityLayer();
  document.getElementById('densityLegend').classList.add('visible');
  setAttrib();
}

historyToggle.addEventListener('change', () => {
  if (historyToggle.checked) {
    exportHistory.addTo(map);
  } else {
    map.removeLayer(exportHistory);
  }
});

setAttrib();
refreshSelectionLabels();

function setExportButtonLabel(){
  if (!exportBtn) return;
  const label = exportBtn.querySelector('.label');
  if (!label) return;
  if (isHgtActive && hgtSelectionRect) {
    label.textContent = 'Export HGT';
    return;
  }
  label.textContent = selectionRect ? 'Export Box' : 'Export View';
}

function refreshSelectionLabels(){
  setExportButtonLabel();
}

function getActiveSelectionRect(){
  return drawingBoxType === 'hgt' ? hgtSelectionRect : selectionRect;
}

function setActiveSelectionRect(rect){
  if (drawingBoxType === 'hgt') hgtSelectionRect = rect;
  else selectionRect = rect;
}

function getActiveBoxColor(){
  return drawingBoxType === 'hgt' ? '#c1121f' : '#1e90ff';
}

function clampHgtLat(lat){
  return Math.max(HGT_MIN_LAT, Math.min(HGT_MAX_LAT, lat));
}

function clampBoundsForActiveTool(bounds){
  if (drawingBoxType !== 'hgt') return bounds;
  const south = clampHgtLat(bounds.getSouth());
  const north = clampHgtLat(bounds.getNorth());
  return L.latLngBounds(
    L.latLng(Math.min(south, north), bounds.getWest()),
    L.latLng(Math.max(south, north), bounds.getEast())
  );
}

function clampHgtDragDeltaLat(bounds, dLat){
  if (drawingBoxType !== 'hgt') return dLat;
  const minDelta = HGT_MIN_LAT - bounds.getSouth();
  const maxDelta = HGT_MAX_LAT - bounds.getNorth();
  return Math.max(minDelta, Math.min(maxDelta, dLat));
}

function enableMapCursor(active){
  const mapEl = document.getElementById('map');
  const mapContainer = map.getContainer();
  mapEl.style.cursor = active ? 'crosshair' : '';
  mapContainer.classList.toggle('force-crosshair', !!active);

  // Only show the full-screen event-capturing overlay for box drawing mode.
  // For ruler mode we only need a crosshair cursor; overlay would block control clicks.
  if (active && isDrawingBox) {
    // Create a transparent overlay that captures all mouse events
    // This prevents Leaflet (and ArcGIS tiles) from processing drag events
    if (!drawingOverlay) {
      drawingOverlay = document.createElement('div');
      drawingOverlay.id = 'drawing-overlay';
      drawingOverlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 950;
        cursor: crosshair;
        background: transparent;
        pointer-events: auto;
      `;
      // Ensure map container has relative positioning
      if (window.getComputedStyle(mapContainer).position === 'static') {
        mapContainer.style.position = 'relative';
      }
      mapContainer.appendChild(drawingOverlay);

      // Update overlay size when map resizes
      map.on('resize', () => {
        if (drawingOverlay) {
          const container = map.getContainer();
          drawingOverlay.style.width = container.offsetWidth + 'px';
          drawingOverlay.style.height = container.offsetHeight + 'px';
        }
      });
    }
    // Ensure overlay covers the entire map
    drawingOverlay.style.width = mapContainer.offsetWidth + 'px';
    drawingOverlay.style.height = mapContainer.offsetHeight + 'px';
    drawingOverlay.style.display = 'block';
  } else {
    // Hide the overlay when not drawing
    if (drawingOverlay) {
      drawingOverlay.style.display = 'none';
      // Clean up handlers
      drawingOverlay.onmousedown = null;
      drawingOverlay.onmousemove = null;
      drawingOverlay.onmouseup = null;
    }
  }

  // If cursor is active for a non-box mode (e.g. ruler), ensure overlay stays hidden.
  if (active && !isDrawingBox && drawingOverlay) {
    drawingOverlay.style.display = 'none';
    drawingOverlay.onmousedown = null;
    drawingOverlay.onmousemove = null;
    drawingOverlay.onmouseup = null;
  }
}

function createOrRemoveBox(){
  drawingBoxType = 'map';
  if (selectionRect){
    map.removeLayer(selectionRect); selectionRect = null; boxStart = null; isDrawingBox = false;
    map.dragging.enable();
    map.boxZoom.enable();
    map.doubleClickZoom.enable();
    map.touchZoom.enable();
    map.scrollWheelZoom.enable();
    map.keyboard.enable();
    refreshSelectionLabels();
    enableMapCursor(false);
    // Clean up overlay handlers
    if (drawingOverlay) {
      drawingOverlay.onmousedown = null;
      drawingOverlay.onmousemove = null;
      drawingOverlay.onmouseup = null;
    }
    refreshBoxButton();
    return;
  }
  // Deactivate ruler if active
  if (isRulerActive) {
    isRulerActive = false;
    clearRuler();
    setRulerControlActive(false);
  }
  // Deactivate HGT tool if active (tools are mutually exclusive)
  if (isHgtActive) {
    isHgtActive = false;
    if (hgtSelectionRect) {
      map.removeLayer(hgtSelectionRect);
      hgtSelectionRect = null;
    }
    refreshHgtAvailabilityOverlay();
    refreshHgtControlButton();
  }
  isDrawingBox = true; boxStart = null; pendingCorner = null;
  // Disable map interactions while drawing - do this immediately and forcefully
  map.dragging.disable();
  map.boxZoom.disable();
  map.doubleClickZoom.disable();
  // Also disable touch zoom and keyboard navigation
  map.touchZoom.disable();
  map.scrollWheelZoom.disable();
  map.keyboard.disable();
  enableMapCursor(true);
  setupDrawingOverlayHandlers();  // Set up overlay event handlers
  refreshBoxButton();
  refreshSelectionLabels();
}

function createOrRemoveHgtBox(){
  drawingBoxType = 'hgt';
  if (isHgtActive) {
    if (hgtSelectionRect) {
      map.removeLayer(hgtSelectionRect);
      hgtSelectionRect = null;
    }
    boxStart = null;
    pendingCorner = null;
    isDrawingBox = false;
    isHgtActive = false;
    map.dragging.enable();
    map.boxZoom.enable();
    map.doubleClickZoom.enable();
    map.touchZoom.enable();
    map.scrollWheelZoom.enable();
    map.keyboard.enable();
    enableMapCursor(false);
    if (drawingOverlay) {
      drawingOverlay.onmousedown = null;
      drawingOverlay.onmousemove = null;
      drawingOverlay.onmouseup = null;
    }
    refreshHgtAvailabilityOverlay();
    refreshSelectionLabels();
    refreshHgtControlButton();
    return;
  }
  isHgtActive = true;
  refreshHgtAvailabilityOverlay();
  // Deactivate regular map box mode/selection (tools are mutually exclusive)
  if (selectionRect) {
    map.removeLayer(selectionRect);
    selectionRect = null;
  }
  if (isRulerActive) {
    isRulerActive = false;
    clearRuler();
    setRulerControlActive(false);
  }
  isDrawingBox = true; boxStart = null; pendingCorner = null;
  map.dragging.disable();
  map.boxZoom.disable();
  map.doubleClickZoom.disable();
  map.touchZoom.disable();
  map.scrollWheelZoom.disable();
  map.keyboard.disable();
  enableMapCursor(true);
  setupDrawingOverlayHandlers();
  refreshHgtControlButton();
  refreshBoxButton();
  refreshSelectionLabels();
}

function deleteActiveSquare() {
  let removed = false;
  if (isHgtActive && hgtSelectionRect) {
    map.removeLayer(hgtSelectionRect);
    hgtSelectionRect = null;
    boxStart = null;
    pendingCorner = null;
    isDrawingBox = false;
    isHgtActive = false;
    refreshHgtAvailabilityOverlay();
    refreshHgtControlButton();
    removed = true;
  } else if (selectionRect) {
    map.removeLayer(selectionRect);
    selectionRect = null;
    boxStart = null;
    pendingCorner = null;
    isDrawingBox = false;
    refreshBoxButton();
    removed = true;
  }
  if (removed) {
    map.dragging.enable();
    map.boxZoom.enable();
    map.doubleClickZoom.enable();
    map.touchZoom.enable();
    map.scrollWheelZoom.enable();
    map.keyboard.enable();
    enableMapCursor(false);
    refreshSelectionLabels();
  }
}

// Ruler Tool Logic - Google Maps Style with Drag & Delete
let isRulerActive = false;
let rulerPoints = [];       // Array of L.LatLng objects
let rulerPolyline = null;
let rulerTempLine = null;
let rulerMarkers = [];      // Array of L.Marker objects (draggable)
let rulerSegmentLabels = [];
let rulerTotalLabel = null;
let isDraggingRulerPoint = false;

function formatDistance(meters) {
  if (typeof meters !== 'number') return '';
  switch(rulerUnits) {
    case 'km': return (meters / 1000).toFixed(2) + ' km';
    case 'ft': return (meters * 3.28084).toFixed(0) + ' ft';
    case 'mi': return (meters * 0.000621371).toFixed(2) + ' mi';
    case 'nm': return (meters * 0.000539957).toFixed(2) + ' nm';
    default: return meters.toFixed(0) + ' m';
  }
}

function clearRuler() {
  if (rulerPolyline) map.removeLayer(rulerPolyline);
  if (rulerTempLine) map.removeLayer(rulerTempLine);
  if (rulerTotalLabel) map.removeLayer(rulerTotalLabel);
  rulerMarkers.forEach(m => map.removeLayer(m));
  rulerSegmentLabels.forEach(l => map.removeLayer(l));
  rulerPoints = [];
  rulerPolyline = null;
  rulerTempLine = null;
  rulerMarkers = [];
  rulerSegmentLabels = [];
  rulerTotalLabel = null;
  isDraggingRulerPoint = false;
}

function deactivateRuler() {
  isRulerActive = false;
  enableMapCursor(false);
  clearRuler();
  setRulerControlActive(false);
}

function getSegmentMidpoint(p1, p2) {
  return L.latLng((p1.lat + p2.lat) / 2, (p1.lng + p2.lng) / 2);
}

// Create custom marker icon for ruler points
// Small white filled circles, thin blue outline (#1A73E8), slight shadow
function createRulerMarkerIcon(isFirst, isHovered = false, isNew = false, isDragging = false) {
  const size = isFirst ? 12 : 10;
  const borderWidth = 2;
  const totalSize = size + borderWidth * 2;

  const classes = ['ruler-point'];
  if (isNew) classes.push('new');
  if (isDragging) classes.push('dragging');

  const hoverScale = isHovered && !isDragging ? 'transform: scale(1.2);' : '';
  const dragScale = isDragging ? 'transform: scale(1.25);' : '';

  return L.divIcon({
    className: 'ruler-point-marker',
    html: `<div class="${classes.join(' ')}" style="
      width: ${size}px;
      height: ${size}px;
      border: ${borderWidth}px solid #1a73e8;
      ${hoverScale}
      ${dragScale}
    "></div>`,
    iconSize: [totalSize, totalSize],
    iconAnchor: [totalSize / 2, totalSize / 2]
  });
}

// Update polyline from current points
// Solid Google-blue (#1A73E8), 2-3px, smooth edges
function updateRulerPolyline() {
  if (rulerPoints.length > 1) {
    if (rulerPolyline) {
      rulerPolyline.setLatLngs(rulerPoints);
    } else {
      rulerPolyline = L.polyline(rulerPoints, {
        color: '#1a73e8',
        weight: 3,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
        pane: 'selectionPane'
      }).addTo(map);
    }
  } else if (rulerPolyline) {
    map.removeLayer(rulerPolyline);
    rulerPolyline = null;
  }
}

// Collision detection helper - check if two screen boxes overlap
function labelsOverlap(box1, box2) {
  return !(box1.right < box2.left ||
           box1.left > box2.right ||
           box1.bottom < box2.top ||
           box1.top > box2.bottom);
}

// Calculate offset to avoid collision
function getOffsetToAvoid(existingBoxes, newBox, baseOffset = { x: 0, y: 0 }) {
  const offsets = [
    { x: 0, y: 0 },      // No offset
    { x: 0, y: -25 },    // Above
    { x: 0, y: 25 },     // Below
    { x: 30, y: 0 },     // Right
    { x: -30, y: 0 },    // Left
    { x: 20, y: -20 },   // Top-right
    { x: -20, y: -20 },  // Top-left
    { x: 20, y: 20 },    // Bottom-right
    { x: -20, y: 20 },   // Bottom-left
  ];

  for (const offset of offsets) {
    const testBox = {
      left: newBox.left + offset.x + baseOffset.x,
      right: newBox.right + offset.x + baseOffset.x,
      top: newBox.top + offset.y + baseOffset.y,
      bottom: newBox.bottom + offset.y + baseOffset.y
    };

    let hasCollision = false;
    for (const existing of existingBoxes) {
      if (labelsOverlap(testBox, existing)) {
        hasCollision = true;
        break;
      }
    }

    if (!hasCollision) {
      return { x: offset.x + baseOffset.x, y: offset.y + baseOffset.y };
    }
  }

  // If all positions collide, use a vertical stack offset
  return { x: baseOffset.x, y: existingBoxes.length * 22 + baseOffset.y };
}

function updateRulerLabels(animate = false) {
  // Remove old segment labels
  rulerSegmentLabels.forEach(l => map.removeLayer(l));
  rulerSegmentLabels = [];
  if (rulerTotalLabel) map.removeLayer(rulerTotalLabel);
  rulerTotalLabel = null;

  if (rulerPoints.length < 2) return;

  let totalDist = 0;
  const animClass = animate ? ' new' : '';
  const labelBoxes = []; // Track label positions for collision detection

  // Estimate label dimensions (approximate)
  const segLabelHeight = 22;
  const segLabelWidthPerChar = 7;
  const totalLabelHeight = 28;
  const totalLabelWidthPerChar = 8;

  // Add segment labels at midpoints - white pill, dark gray text, auto-resize
  for (let i = 0; i < rulerPoints.length - 1; i++) {
    const segDist = rulerPoints[i].distanceTo(rulerPoints[i + 1]);
    totalDist += segDist;

    const midpoint = getSegmentMidpoint(rulerPoints[i], rulerPoints[i + 1]);
    const screenPos = map.latLngToContainerPoint(midpoint);

    // Estimate label size
    const labelText = formatDistance(segDist);
    const labelWidth = labelText.length * segLabelWidthPerChar + 20;

    // Create initial box (centered on midpoint)
    const newBox = {
      left: screenPos.x - labelWidth / 2,
      right: screenPos.x + labelWidth / 2,
      top: screenPos.y - segLabelHeight / 2,
      bottom: screenPos.y + segLabelHeight / 2
    };

    // Get offset to avoid collisions
    const offset = getOffsetToAvoid(labelBoxes, newBox);

    // Add to tracked boxes
    labelBoxes.push({
      left: newBox.left + offset.x,
      right: newBox.right + offset.x,
      top: newBox.top + offset.y,
      bottom: newBox.bottom + offset.y
    });

    const segLabel = L.marker(midpoint, {
      icon: L.divIcon({
        className: 'ruler-segment-icon',
        html: `<div class="ruler-segment-label${animClass}" style="transform: translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px));">${labelText}</div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0]
      }),
      interactive: false,
      pane: 'rulerLabelsPane',
      zIndexOffset: 1000 + i
    }).addTo(map);
    rulerSegmentLabels.push(segLabel);
  }

  // Add total distance label at last point - larger blue pill, bold white text
  const lastPoint = rulerPoints[rulerPoints.length - 1];
  const lastScreenPos = map.latLngToContainerPoint(lastPoint);
  const totalText = formatDistance(totalDist);
  const totalWidth = totalText.length * totalLabelWidthPerChar + 28;

  // Create box for total label (offset to the right by default)
  const totalBox = {
    left: lastScreenPos.x + 8,
    right: lastScreenPos.x + 8 + totalWidth,
    top: lastScreenPos.y - totalLabelHeight / 2,
    bottom: lastScreenPos.y + totalLabelHeight / 2
  };

  // Get offset to avoid collisions with segment labels
  const totalOffset = getOffsetToAvoid(labelBoxes, totalBox, { x: 8, y: 0 });

  rulerTotalLabel = L.marker(lastPoint, {
    icon: L.divIcon({
      className: 'ruler-total-icon',
      html: `<div class="ruler-total-label${animClass}" style="transform: translate(${totalOffset.x}px, calc(-50% + ${totalOffset.y}px));">${totalText}</div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0]
    }),
    interactive: false,
    pane: 'rulerLabelsPane',
    zIndexOffset: 2000
  }).addTo(map);
}

// Delete a ruler point by index
function deleteRulerPoint(index) {
  if (index < 0 || index >= rulerPoints.length) return;

  // Remove the marker
  map.removeLayer(rulerMarkers[index]);
  rulerMarkers.splice(index, 1);
  rulerPoints.splice(index, 1);

  // If only one point left or none, clean up accordingly
  if (rulerPoints.length === 0) {
    clearRuler();
    return;
  }

  // Update first marker style if index 0 was deleted
  if (index === 0 && rulerMarkers.length > 0) {
    rulerMarkers[0].setIcon(createRulerMarkerIcon(true));
  }

  // Update polyline and labels
  updateRulerPolyline();
  updateRulerLabels();
}

function addRulerPoint(latlng) {
  const pointIndex = rulerPoints.length;
  rulerPoints.push(latlng);

  // Create draggable marker with custom icon - with pop animation
  const isFirst = pointIndex === 0;
  const marker = L.marker(latlng, {
    icon: createRulerMarkerIcon(isFirst, false, true), // isNew = true for animation
    draggable: true,
    autoPan: false,
    pane: 'selectionPane',
    zIndexOffset: 1000
  }).addTo(map);

  // Remove the 'new' class after animation completes
  setTimeout(() => {
    if (rulerMarkers.includes(marker)) {
      marker.setIcon(createRulerMarkerIcon(isFirst, false, false));
    }
  }, 300);

  // Store index on marker for reference
  marker._rulerIndex = pointIndex;

  // Track if this marker was dragged (to prevent click-to-delete after drag)
  let wasDragged = false;
  let dragStartTime = 0;

  // Hover effects - enlarge by ~20%
  marker.on('mouseover', function() {
    if (!isDraggingRulerPoint) {
      const idx = rulerMarkers.indexOf(this);
      if (idx !== -1) this.setIcon(createRulerMarkerIcon(idx === 0, true, false, false));
    }
  });

  marker.on('mouseout', function() {
    if (!isDraggingRulerPoint) {
      const idx = rulerMarkers.indexOf(this);
      if (idx !== -1) this.setIcon(createRulerMarkerIcon(idx === 0, false, false, false));
    }
  });

  // Drag events - smooth interpolation when dragging
  marker.on('dragstart', function(e) {
    L.DomEvent.stopPropagation(e);
    isDraggingRulerPoint = true;
    wasDragged = true;
    dragStartTime = Date.now();
    const idx = rulerMarkers.indexOf(this);
    if (idx !== -1) this.setIcon(createRulerMarkerIcon(idx === 0, false, false, true));
    // Remove temp line while dragging
    if (rulerTempLine) {
      map.removeLayer(rulerTempLine);
      rulerTempLine = null;
    }
  });

  marker.on('drag', function(e) {
    const idx = rulerMarkers.indexOf(this);
    if (idx !== -1) {
      rulerPoints[idx] = e.target.getLatLng();
      updateRulerPolyline();
      updateRulerLabels(false); // No animation during drag for smooth updates
    }
  });

  marker.on('dragend', function(e) {
    L.DomEvent.stopPropagation(e);
    // Keep isDraggingRulerPoint true for a short moment to prevent click events
    setTimeout(() => {
      isDraggingRulerPoint = false;
    }, 100);
    const idx = rulerMarkers.indexOf(this);
    if (idx !== -1) this.setIcon(createRulerMarkerIcon(idx === 0, false, false, false));
  });

  // Click to delete - only if it was a quick click, not after dragging
  marker.on('click', function(e) {
    L.DomEvent.stopPropagation(e);

    // Don't delete if we just finished dragging (wait 200ms after drag)
    const timeSinceDrag = Date.now() - dragStartTime;
    if (wasDragged && timeSinceDrag < 200) {
      wasDragged = false;
      return;
    }

    // Don't delete while dragging
    if (isDraggingRulerPoint) return;

    const idx = rulerMarkers.indexOf(this);
    if (idx !== -1) {
      deleteRulerPoint(idx);
    }
  });

  rulerMarkers.push(marker);

  // Update polyline and labels with animation
  updateRulerPolyline();
  updateRulerLabels(true); // Animate new labels
}

const controls = initMapToolControls({
  allowedTools,
  mountEl: document.getElementById('toolBtnGroup'),
  onRulerButtonReady: (btn) => {
    rulerControlBtn = btn;
  },
  onBoxClick: () => {
    drawingBoxType = 'map';
    createOrRemoveBox();
  },
  getBoxButtonState: () => {
    if (selectionRect) return 'delete';
    if (isMapBoxDrawingActive()) return 'place';
    return 'draw';
  },
  onToggleRuler: () => {
    if (isRulerActive) {
      deactivateRuler();
      return;
    }
    // Activate ruler - deactivate box drawing if active
    if (isDrawingBox) {
      isDrawingBox = false;
      map.dragging.enable();
      map.boxZoom.enable();
      map.doubleClickZoom.enable();
      refreshBoxButton();
    }
    if (isHgtActive) {
      isHgtActive = false;
      if (hgtSelectionRect) {
        map.removeLayer(hgtSelectionRect);
        hgtSelectionRect = null;
      }
      refreshHgtAvailabilityOverlay();
      refreshSelectionLabels();
      refreshHgtControlButton();
    }
    pendingCorner = null; // Clear any pending box corner
    isRulerActive = true;
    enableMapCursor(true);
    clearRuler();
    setRulerControlActive(true);
  },
  onHgtButtonReady: (btn) => {
    hgtControlBtn = btn;
    refreshHgtControlButton();
  },
  onHgtClick: () => {
    createOrRemoveHgtBox();
    refreshSelectionLabels();
    refreshHgtControlButton();
    refreshBoxButton(); // keep map-box button untoggled while HGT is active
  },
  onHideInlineHgtButton: () => {
    if (hgtBoxBtn) hgtBoxBtn.style.display = 'none';
  },
  onToolsReady: () => {
    applyToolbarOverflowLayout();
    updateMoreButtonsHighlight();
  }
});
refreshBoxButton = () => {
  controls.refreshBoxButton();
  if (typeof updateMoreButtonsHighlight === 'function') updateMoreButtonsHighlight();
};

// Map events for Ruler
map.on('click', (e) => {
  if (!isRulerActive || isDraggingRulerPoint) return;
  addRulerPoint(e.latlng);
});

map.on('mousemove', (e) => {
   if (!isRulerActive || rulerPoints.length === 0 || isDraggingRulerPoint) return;
   const lastPoint = rulerPoints[rulerPoints.length - 1];
   const current = e.latlng;

   if (!rulerTempLine) {
      // Preview line: dashed light-blue, semi-transparent, short dashes
      rulerTempLine = L.polyline([lastPoint, current], {
        color: '#4dabf7',  // Light blue
        weight: 2,
        dashArray: '6, 6', // Short dashes
        opacity: 0.6,      // Semi-transparent
        lineCap: 'round',
        pane: 'selectionPane'
      }).addTo(map);
   } else {
      rulerTempLine.setLatLngs([lastPoint, current]);
   }
});

const API_BASE = '';

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const safeName = filename || 'download.bin';

  // Mobile browsers often block programmatic downloads after await/confirm.
  // Show an explicit tap target so the save stays in a real user gesture.
  if (isMobileApp) {
    const toast = document.getElementById('mobileDownloadToast');
    const link = document.getElementById('mobileDownloadLink');
    const dismiss = document.getElementById('mobileDownloadDismiss');
    if (toast && link) {
      if (link.dataset.blobUrl) {
        try { URL.revokeObjectURL(link.dataset.blobUrl); } catch (_) { /* ignore */ }
      }
      link.href = url;
      link.download = safeName;
      link.textContent = `Save ${safeName}`;
      link.dataset.blobUrl = url;
      toast.hidden = false;

      const closeToast = () => {
        toast.hidden = true;
        // Keep blob alive briefly in case the share sheet is still opening.
        setTimeout(() => {
          if (link.dataset.blobUrl === url) {
            try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
            link.removeAttribute('href');
            delete link.dataset.blobUrl;
            link.textContent = 'Save file';
          }
        }, 60_000);
      };
      dismiss?.addEventListener('click', closeToast, { once: true });
      link.addEventListener('click', () => {
        // After the user taps Save, close shortly afterward.
        setTimeout(closeToast, 800);
      }, { once: true });
      return;
    }
  }

  const a = document.createElement('a');
  a.href = url;
  a.download = safeName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    a.remove();
  }, 10_000);
}

async function exportHgtTiles(customName, bboxOverride = null) {
  let bbox;
  if (Array.isArray(bboxOverride) && bboxOverride.length === 4) {
    bbox = normalizeWrappedHgtBbox(bboxOverride);
  } else if (hgtSelectionRect) {
    const b = hgtSelectionRect.getBounds();
    bbox = normalizeWrappedHgtBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  } else {
    throw new Error('Draw a selection box first, then export HGT.');
  }
  const requestedTileCount = countHgtTilesForBbox(bbox);
  if (requestedTileCount > HGT_EXPORT_MAX_TILES) {
    throw new Error(
      `HGT export cancelled: ${requestedTileCount} tiles requested, maximum allowed is ${HGT_EXPORT_MAX_TILES}. Reduce the box size and try again.`
    );
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const baseName = customName || `hgt_export_${ts}`;
  const payload = {
    bbox,
    filename: baseName,
    base: baseSelect?.value || 'esri',
    zoom: map.getZoom(),
    system: exportSystem?.value || undefined
  };
  console.log('[HGT Export] Request payload:', payload);
  const res = await fetch(`${API_BASE}/export_hgt?r=${Date.now()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify(payload)
  });
  console.log('[HGT Export] Response status:', res.status, res.statusText);
  if (!res.ok) {
    const t = await res.text();
    console.error('[HGT Export] Failed response body:', t);
    throw new Error(t || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  console.log('[HGT Export] Success, zip size (bytes):', blob.size);
  if (!blob || blob.size < 32) {
    throw new Error('HGT export returned an empty file.');
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const match = cd.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
  const serverName = match ? decodeURIComponent((match[1] || match[2] || '').trim()) : '';
  downloadBlob(blob, serverName || `${baseName}.zip`);
}

function normalizeWrappedHgtBbox(bbox) {
  let [west, south, east, north] = bbox;
  // If both longitudes are in the same wrapped world copy, shift them by 360
  // until they fall in the canonical [-180, 180] range.
  while (west < -180 && east < -180) {
    west += 360;
    east += 360;
  }
  while (west > 180 && east > 180) {
    west -= 360;
    east -= 360;
  }
  return [west, south, east, north];
}

function countHgtTilesForBbox(bbox) {
  const [west, south, east, north] = bbox;
  const eps = 1e-9;
  const minLon = Math.floor(west);
  const maxLon = Math.ceil(east - eps) - 1;
  const minLat = Math.floor(south);
  const maxLat = Math.ceil(north - eps) - 1;
  if (maxLon < minLon || maxLat < minLat) return 0;
  return (maxLon - minLon + 1) * (maxLat - minLat + 1);
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const settingsOpen = document.getElementById('userSettingsModal')?.style.display === 'flex';
  if (settingsOpen) return;
  deleteActiveSquare();
});

// Draw rectangle by click-drag; allow dragging the rectangle itself
// Use overlay div to capture events instead of map events for better control
function setupDrawingOverlayHandlers() {
  if (!drawingOverlay) return;

  // Remove existing handlers to avoid duplicates
  drawingOverlay.onmousedown = null;
  drawingOverlay.onmousemove = null;
  drawingOverlay.onmouseup = null;

  drawingOverlay.onmousedown = (e) => {
    if (!isDrawingBox) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Get map coordinates from mouse position
    const mapContainer = map.getContainer();
    const rect = mapContainer.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const point = L.point(x, y);
    const latlng = map.containerPointToLatLng(point);

    boxStart = latlng;

    // Handle mousemove on overlay
    drawingOverlay.onmousemove = (moveE) => {
      if (!isDrawingBox || !boxStart) return;
      moveE.preventDefault();
      moveE.stopPropagation();

      const moveRect = mapContainer.getBoundingClientRect();
      const moveX = moveE.clientX - moveRect.left;
      const moveY = moveE.clientY - moveRect.top;
      const movePoint = L.point(moveX, moveY);
      const moveLatlng = map.containerPointToLatLng(movePoint);

      const sw = L.latLng(Math.min(boxStart.lat, moveLatlng.lat), Math.min(boxStart.lng, moveLatlng.lng));
      const ne = L.latLng(Math.max(boxStart.lat, moveLatlng.lat), Math.max(boxStart.lng, moveLatlng.lng));
      const bounds = clampBoundsForActiveTool(L.latLngBounds(sw, ne));

      if (!getActiveSelectionRect()){
        const activeColor = getActiveBoxColor();
        const newRect = L.rectangle(bounds, {
          color: activeColor, weight: 2, fillColor: activeColor, fillOpacity: 0.2,
          interactive: true, pane: 'selectionPane'
        }).addTo(map);
        setActiveSelectionRect(newRect);
        const activeRect = getActiveSelectionRect();
        activeRect.bringToFront();
        // Simple drag handler for rectangle
        let dragOrigin = null;
        activeRect.on('mousedown', (ev)=>{
          const currentRect = getActiveSelectionRect();
          if (!currentRect) return; ev.originalEvent.preventDefault(); L.DomEvent.stopPropagation(ev);
          map.dragging.disable();
          dragOrigin = ev.latlng;
          function onMove(mv){
            if (!dragOrigin) return;
            const cur = mv.latlng;
            const rawDLat = cur.lat - dragOrigin.lat;
            const dLng = cur.lng - dragOrigin.lng;
            const b = currentRect.getBounds();
            const dLat = clampHgtDragDeltaLat(b, rawDLat);
            const sw2 = L.latLng(b.getSouth() + dLat, b.getWest() + dLng);
            const ne2 = L.latLng(b.getNorth() + dLat, b.getEast() + dLng);
            currentRect.setBounds(clampBoundsForActiveTool(L.latLngBounds(sw2, ne2)));
            dragOrigin = cur;
          }
          function onUp(){ map.off('mousemove', onMove); map.off('mouseup', onUp); dragOrigin=null; map.dragging.enable(); }
          map.on('mousemove', onMove); map.on('mouseup', onUp);
        });
      } else {
        getActiveSelectionRect().setBounds(bounds);
      }
    };

    // Handle mouseup on overlay
    drawingOverlay.onmouseup = (upE) => {
      if (!isDrawingBox) return;
      upE.preventDefault();
      upE.stopPropagation();

      isDrawingBox = false;
      enableMapCursor(false);
      refreshSelectionLabels();

      // Clean up overlay handlers
      drawingOverlay.onmousemove = null;
      drawingOverlay.onmouseup = null;

      // Re-enable map interactions
      map.dragging.enable();
      map.boxZoom.enable();
      map.doubleClickZoom.enable();
      map.touchZoom.enable();
      map.scrollWheelZoom.enable();
      map.keyboard.enable();
      refreshBoxButton();
      refreshHgtControlButton();
    };
  };
}

// Keep map handlers as fallback, but overlay should handle everything
map.on('mousedown', (e)=>{
  if (!isDrawingBox) return;
  // If overlay exists, let it handle it
  if (drawingOverlay && drawingOverlay.style.display !== 'none') {
    return;
  }
  e.originalEvent.preventDefault();
  e.originalEvent.stopImmediatePropagation();
  L.DomEvent.stopPropagation(e);
  L.DomEvent.stop(e);
  if (map.dragging.enabled()) {
    map.dragging.disable();
  }
  boxStart = e.latlng;
});

map.on('mousemove', (e)=>{
  if (!isDrawingBox || !boxStart) return;
  // If overlay exists, let it handle it
  if (drawingOverlay && drawingOverlay.style.display !== 'none') {
    return;
  }
  e.originalEvent.preventDefault();
  L.DomEvent.stopPropagation(e);
  L.DomEvent.stop(e);
  if (map.dragging.enabled()) {
    map.dragging.disable();
  }
  const sw = L.latLng(Math.min(boxStart.lat, e.latlng.lat), Math.min(boxStart.lng, e.latlng.lng));
  const ne = L.latLng(Math.max(boxStart.lat, e.latlng.lat), Math.max(boxStart.lng, e.latlng.lng));
  const bounds = clampBoundsForActiveTool(L.latLngBounds(sw, ne));
  if (!getActiveSelectionRect()){
    const activeColor = getActiveBoxColor();
    const newRect = L.rectangle(bounds, {
      color: activeColor, weight: 2, fillColor: activeColor, fillOpacity: 0.2,
      interactive: true, pane: 'selectionPane'
    }).addTo(map);
    setActiveSelectionRect(newRect);
    const activeRect = getActiveSelectionRect();
    activeRect.bringToFront();
    // Simple drag handler for rectangle
    let dragOrigin = null;
    activeRect.on('mousedown', (ev)=>{
      const currentRect = getActiveSelectionRect();
      if (!currentRect) return; ev.originalEvent.preventDefault(); L.DomEvent.stopPropagation(ev);
      map.dragging.disable();
      dragOrigin = ev.latlng;
      function onMove(mv){
        if (!dragOrigin) return;
        const cur = mv.latlng;
        const rawDLat = cur.lat - dragOrigin.lat;
        const dLng = cur.lng - dragOrigin.lng;
        const b = currentRect.getBounds();
        const dLat = clampHgtDragDeltaLat(b, rawDLat);
        const sw2 = L.latLng(b.getSouth() + dLat, b.getWest() + dLng);
        const ne2 = L.latLng(b.getNorth() + dLat, b.getEast() + dLng);
        currentRect.setBounds(clampBoundsForActiveTool(L.latLngBounds(sw2, ne2)));
        dragOrigin = cur;
      }
      function onUp(){ map.off('mousemove', onMove); map.off('mouseup', onUp); dragOrigin=null; map.dragging.enable(); }
      map.on('mousemove', onMove); map.on('mouseup', onUp);
    });
  } else {
    getActiveSelectionRect().setBounds(bounds);
  }
});

map.on('mouseup', ()=>{
  // If overlay is handling events, don't process here
  if (drawingOverlay && drawingOverlay.style.display !== 'none') {
    return;
  }
  if (isDrawingBox){
    isDrawingBox = false;
    enableMapCursor(false);
    refreshSelectionLabels();
  }
  // Re-enable map interactions after drawing concludes
  map.dragging.enable();
  map.boxZoom.enable();
  map.doubleClickZoom.enable();
  map.touchZoom.enable();
  map.scrollWheelZoom.enable();
  map.keyboard.enable();
  refreshBoxButton();
  refreshHgtControlButton();
});

// --- Touch support ------------------------------------------------------
map.on('touchstart', (e)=>{
  if (isRulerActive) return;
  // Two-tap corner mode when not drawing and no rectangle yet
  if (!isDrawingBox && !getActiveSelectionRect()) {
    // Start long-press timer to enter drag-draw mode
    if (longPressTimer) clearTimeout(longPressTimer);
    const startLatLng = e.latlng;
    longPressTimer = setTimeout(()=>{
      // Long press detected → start drag-draw mode
      isDrawingBox = true; boxStart = startLatLng; enableMapCursor(true);
      map.dragging.disable(); map.boxZoom.disable(); map.doubleClickZoom.disable();
    }, 350);
  }
});

map.on('touchmove', (e)=>{
  if (isRulerActive) return;
  if (longPressTimer && isDrawingBox){
    // Prevent page scrolling while drawing
    try { e.originalEvent && e.originalEvent.preventDefault && e.originalEvent.preventDefault(); } catch(_){ }
    const sw = L.latLng(Math.min(boxStart.lat, e.latlng.lat), Math.min(boxStart.lng, e.latlng.lng));
    const ne = L.latLng(Math.max(boxStart.lat, e.latlng.lat), Math.max(boxStart.lng, e.latlng.lng));
    const bounds = clampBoundsForActiveTool(L.latLngBounds(sw, ne));
    if (!getActiveSelectionRect()){
      const activeColor = getActiveBoxColor();
      const newRect = L.rectangle(bounds, {
        color: activeColor, weight: 2, fillColor: activeColor, fillOpacity: 0.2,
        interactive: true, pane: 'selectionPane'
      }).addTo(map);
      setActiveSelectionRect(newRect);
      const activeRect = getActiveSelectionRect();
      activeRect.bringToFront();
      pendingCorner = null; refreshSelectionLabels();
      // Add touch-drag for the rectangle itself
      let dragOrigin = null;
      activeRect.on('touchstart', (ev)=>{
        const currentRect = getActiveSelectionRect();
        if (!currentRect) return; L.DomEvent.stopPropagation(ev);
        map.dragging.disable(); dragOrigin = ev.latlng;
        function onMove(mv){
          if (!dragOrigin) return; const cur = mv.latlng;
          const rawDLat = cur.lat - dragOrigin.lat; const dLng = cur.lng - dragOrigin.lng;
          const b = currentRect.getBounds();
          const dLat = clampHgtDragDeltaLat(b, rawDLat);
          const sw2 = L.latLng(b.getSouth() + dLat, b.getWest() + dLng);
          const ne2 = L.latLng(b.getNorth() + dLat, b.getEast() + dLng);
          currentRect.setBounds(clampBoundsForActiveTool(L.latLngBounds(sw2, ne2))); dragOrigin = cur;
        }
        function onUp(){ map.off('touchmove', onMove); map.off('touchend', onUp); dragOrigin=null; map.dragging.enable(); }
        map.on('touchmove', onMove); map.on('touchend', onUp);
      });
    } else {
      getActiveSelectionRect().setBounds(bounds);
    }
  }
});

map.on('touchend', (e)=>{
  if (isRulerActive) return;
  if (longPressTimer){ clearTimeout(longPressTimer); longPressTimer = null; }
  if (isDrawingBox){
    // Finish drag-draw
    isDrawingBox = false; enableMapCursor(false); refreshSelectionLabels();
    map.dragging.enable(); map.boxZoom.enable(); map.doubleClickZoom.enable();
    return;
  }
  // Two-tap corner placement
  if (!getActiveSelectionRect()){
    if (!pendingCorner){
      pendingCorner = e.latlng; // first corner
    } else {
      const sw = L.latLng(Math.min(pendingCorner.lat, e.latlng.lat), Math.min(pendingCorner.lng, e.latlng.lng));
      const ne = L.latLng(Math.max(pendingCorner.lat, e.latlng.lat), Math.max(pendingCorner.lng, e.latlng.lng));
      const bounds = clampBoundsForActiveTool(L.latLngBounds(sw, ne));
      const activeColor = getActiveBoxColor();
      const newRect = L.rectangle(bounds, {
        color: activeColor, weight: 2, fillColor: activeColor, fillOpacity: 0.2,
        interactive: true, pane: 'selectionPane'
      }).addTo(map);
      setActiveSelectionRect(newRect);
      getActiveSelectionRect().bringToFront(); pendingCorner = null; refreshSelectionLabels();
    }
  }
});

// Two-corner box selection is now ONLY available in drawing mode
// (Removed automatic two-corner on any click - was causing conflicts)

exportBtn?.addEventListener('click', async () => {
  await performGeotiffExport({});
});

async function performGeotiffExport({ forceView = false, button = exportBtn } = {}) {
  if (!button) return;
  console.log('[Export] ========== Export Started ==========');
  const btn = button;
  const spinner = btn.querySelector?.('.spinner');
  const label = btn.querySelector?.('.label');
  btn.disabled = true;
  btn.classList.add('busy');
  if (spinner) spinner.style.display = 'inline-block';
  if (label) label.textContent = 'Exporting…';
  const b = (!forceView && selectionRect) ? selectionRect.getBounds() : map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  const latMid = (bbox[1]+bbox[3])/2;
  const lonMid = (bbox[0]+bbox[2])/2;
  const zoom = map.getZoom();
  const system = exportSystem?.value || 'UAS';
  const viewW = Math.round(document.getElementById('map').clientWidth);
  const viewH = Math.round(document.getElementById('map').clientHeight);
  const width  = viewW;
  const height = Math.round(width * (viewH / viewW));
  const base = baseSelect.value;
  const canShowNames =
    supportsNamesOverlay(base) &&
    !baseHasNames(base) &&
    isNamesOverlayEnabled;
  const overlays = {
    seamarks: seamarks && seamarksCb.checked,
    openaip: allowedOver.includes('openaip') && openaipCb.checked,
    // "Names" is a frontend-only toggle; headless export needs an explicit flag.
    label: canShowNames
  };
  const crs = undefined; // deprecated in favor of system
  const customName = filenameInput?.value?.trim() || '';
  if (!forceView && isHgtActive && hgtSelectionRect) {
    try {
      await exportHgtTiles(customName);
      // Reset HGT export state back to default export view after completion.
      map.removeLayer(hgtSelectionRect);
      hgtSelectionRect = null;
      isHgtActive = false;
      drawingBoxType = 'map';
      refreshHgtAvailabilityOverlay();
      refreshHgtControlButton();
    } catch (err) {
      alert('HGT export failed: ' + (err?.message || err));
    } finally {
      btn.disabled = false;
      btn.classList.remove('busy');
      if (spinner) spinner.style.display = 'none';
      refreshSelectionLabels();
    }
    return;
  }
  // Use headless export for ALL maps (same rendering method as frontend)
  // This ensures consistent georeferencing and tile placement across all map types
  // All maps (osm, esri, topo, navigation, night, ocean, shom, ukho, gbsouth) use headless export
  // Also use headless when openaip overlay is enabled (requires browser rendering)
  const useHeadless = true; // Always use headless export for consistency
  const endpointBase = 'export_headless';

  console.log('[Export] Export Parameters:', {
    exportType: (!forceView && selectionRect) ? 'Selection Box' : 'Full View',
    bbox: bbox,
    center: { lat: latMid, lon: lonMid },
    zoom: zoom,
    system: system,
    quality: exportQuality?.value,
    baseLayer: base,
    overlays: overlays,
    customFilename: customName || '(none)',
    viewportSize: { width: viewW, height: viewH },
    exportMethod: 'headless',
    endpoint: endpointBase
  });

  // Always deliver final file in EPSG:4326 for UAS (viewer can reproject basemap)
  const outCrs = (system === 'UAS') ? 'EPSG:4326' : undefined;

  // Selection box sizing: SD = pixel size of box; HD = 2x box pixels
  let targetWidth = width, targetHeight = height;
  if (!forceView && selectionRect){
    const bnds = selectionRect.getBounds();
    const tl = map.latLngToContainerPoint(bnds.getNorthWest());
    const br = map.latLngToContainerPoint(bnds.getSouthEast());
    const boxPxW = Math.max(1, Math.round(Math.abs(br.x - tl.x)));
    const boxPxH = Math.max(1, Math.round(Math.abs(br.y - tl.y)));
    const factor = (exportQuality?.value === 'HD') ? 2 : 1;
    targetWidth = boxPxW * factor;
    targetHeight = boxPxH * factor;
    console.log('[Export] Selection Box Sizing:', {
      boxPixels: { width: boxPxW, height: boxPxH },
      qualityFactor: factor,
      targetSize: { width: targetWidth, height: targetHeight }
    });
  } else {
    console.log('[Export] Full View Export - using viewport size:', { width: targetWidth, height: targetHeight });
  }

  // For RADAR modes: adapt zoom to match target pixel size (approx. EPSG:3857 meters/px)
  function zoomForMetersPerPixel(targetMpp, lat){
    const R = 6378137;
    const metersPerPixelAtZ0 = Math.cos(lat * Math.PI/180) * 2 * Math.PI * R / 256;
    const z = Math.log2(metersPerPixelAtZ0 / targetMpp);
    return Math.max(0, Math.min(20, Math.round(z)));
  }
  const radarPixel = system === 'RADAR_overview' ? 25 : (system === 'RADAR_detailed' ? 5 : null);
  const oversample = radarPixel ? (exportQuality?.value === 'HD' ? 3 : 2) : 1;
  const detailBoost = (!forceView && selectionRect && exportQuality?.value === 'HD') ? 1 : 0; // fetch higher-res tiles for HD box
  const usedZoom = radarPixel ? zoomForMetersPerPixel(radarPixel / oversample, latMid) : Math.min(20, zoom + detailBoost);

  console.log('[Export] Zoom & Resolution Settings:', {
    system: system,
    radarPixelSize: radarPixel || 'N/A (UAS mode)',
    oversampleFactor: oversample,
    detailBoost: detailBoost,
    originalZoom: zoom,
    calculatedZoom: usedZoom,
    zoomAdjustment: usedZoom !== zoom ? `Adjusted from ${zoom} to ${usedZoom}` : 'No adjustment'
  });

  // Determine tile usage and split into chunks if too large
  let rows, cols;
  if (radarPixel){
    // Split based on output pixel dimensions at target resolution
    const wMeters = map.distance([latMid, bbox[0]], [latMid, bbox[2]]);
    const hMeters = map.distance([bbox[1], lonMid], [bbox[3], lonMid]);
    const maxPx = 4096; // cap per-part dimension
    cols = Math.max(1, Math.ceil(wMeters / (maxPx * radarPixel)));
    rows = Math.max(1, Math.ceil(hMeters / (maxPx * radarPixel)));
  } else {
    const MAX_TILES = 400; // must match backend
    const pSW = map.project([bbox[1], bbox[0]], usedZoom);
    const pNE = map.project([bbox[3], bbox[2]], usedZoom);
    const pxW = Math.abs(pNE.x - pSW.x);
    const pxH = Math.abs(pSW.y - pNE.y);
    const tilesW = Math.ceil(pxW / 256);
    const tilesH = Math.ceil(pxH / 256);
    const totalTiles = tilesW * tilesH;
    const maxTilesPerSide = Math.floor(Math.sqrt(MAX_TILES));
    const maxPxPerSide = maxTilesPerSide * 256;
    cols = Math.max(1, Math.ceil(pxW / maxPxPerSide));
    rows = Math.max(1, Math.ceil(pxH / maxPxPerSide));
  }

  function splitBbox(bbox, rows, cols){
    const [w,s,e,n] = bbox;
    const lonStep = (e - w) / cols;
    const latStep = (n - s) / rows;
    const parts = [];
    for (let r=0;r<rows;r++){
      for (let c=0;c<cols;c++){
        const ww = w + c*lonStep;
        const ee = w + (c+1)*lonStep;
        const ss = s + r*latStep;
        const nn = s + (r+1)*latStep;
        parts.push([ww, ss, ee, nn]);
      }
    }
    return parts;
  }

  let chunks = (rows*cols > 1) ? splitBbox(bbox, rows, cols) : [bbox];
  // Add overlap for RADAR to avoid gaps between parts
  if (radarPixel){
    const ovPx = 64; // larger overlap to guarantee seamless stitching
    const ovM = ovPx * radarPixel;
    chunks = chunks.map(bb => {
      const [cw,cs,ce,cn] = bb;
      const clat = (cs+cn)/2, clon = (cw+ce)/2;
      const degLat = ovM / 110540; // approx meters per degree latitude
      const degLon = ovM / (111320 * Math.max(0.0001, Math.cos(clat*Math.PI/180)));
      const ww = Math.max(-180, cw - degLon);
      const ee = Math.min( 180, ce + degLon);
      const ss = Math.max( -90, cs - degLat);
      const nn = Math.min(  90, cn + degLat);
      return [ww, ss, ee, nn];
    });
    console.log('[Export] RADAR Overlap Applied:', {
      overlapPixels: ovPx,
      overlapMeters: ovM,
      totalChunks: chunks.length
    });
  }
  const total = chunks.length;
  console.log('[Export] Export Chunking Summary:', {
    totalChunks: total,
    chunkingStrategy: total > 1 ? 'Multi-part export' : 'Single export',
    chunks: chunks.map((chunk, idx) => ({
      part: idx + 1,
      bbox: chunk
    }))
  });
  // Progress feedback
  let completed = 0;
  const partResults = []; // { bbox, finalName } for history overlays

  for (let i=0;i<chunks.length;i++){
    const partBbox = chunks[i];
    if (label) label.textContent = total>1 ? `Exporting ${i+1}/${total}…` : 'Exporting…';
    let partWidth, partHeight;
    if (radarPixel){
      // derive pixels from meters at target resolution (+ overlap already applied to bbox)
      const [w1,s1,e1,n1] = partBbox;
      const midLat = (s1+n1)/2, midLon=(w1+e1)/2;
      const wMeters = map.distance([midLat, w1], [midLat, e1]);
      const hMeters = map.distance([s1, midLon], [n1, midLon]);
      partWidth = Math.max(512, Math.ceil(wMeters / (radarPixel / oversample)));
      partHeight = Math.max(512, Math.ceil(hMeters / (radarPixel / oversample)));
    } else {
      const baseW = (!forceView && selectionRect) ? targetWidth : width;
      const baseH = (!forceView && selectionRect) ? targetHeight : height;
      partWidth = Math.max(256, Math.round(baseW * (1/cols)));
      partHeight = Math.max(256, Math.round(baseH * (1/rows)));
    }
    const partSuffix = total>1 ? `${i+1}of${total}` : '';
    const partName = customName ? (total>1 ? `${customName}_${partSuffix}` : customName) : (total>1 ? `export_${partSuffix}` : 'export');
    const endpoint = endpointBase;
    const showAttribution = document.getElementById('exportAttribution')?.checked ?? true;
    const payload = { bbox: partBbox, zoom: usedZoom, width: partWidth, height: partHeight, base, overlays, system, crs: outCrs, quality: exportQuality?.value || 'SD', filename: partName, showAttribution };

    console.log(`[Export] Part ${i+1}/${total} Starting:`, {
      partNumber: i + 1,
      totalParts: total,
      bbox: partBbox,
      dimensions: { width: partWidth, height: partHeight },
      zoom: usedZoom,
      filename: partName
    });

    // retry wrapper to handle Content-Length / network blips
    async function doExportWithRetry(attempt=1){
      console.log(`[Export] Part ${i+1}/${total} - Request attempt ${attempt}:`, {
        endpoint: `${API_BASE}/${endpoint}`,
        method: 'POST',
        timestamp: new Date().toISOString()
      });
      const res = await fetch(`${API_BASE}/${endpoint}?r=${Date.now()}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const t = await res.text();
        console.warn(`[Export] Part ${i+1}/${total} - Request failed (attempt ${attempt}):`, {
          status: res.status,
          statusText: res.statusText,
          error: t
        });
        if (attempt < 2) {
          console.log(`[Export] Part ${i+1}/${total} - Retrying in 1.2s...`);
          await new Promise(r=>setTimeout(r, 1200));
          return doExportWithRetry(attempt+1);
        }
        throw new Error(t || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      console.log(`[Export] Part ${i+1}/${total} - Request successful:`, {
        status: res.status,
        blobSize: blob.size,
        contentType: blob.type,
        contentLength: res.headers.get('Content-Length')
      });
      return { blob, res };
    }
    try {
      const { blob, res } = await doExportWithRetry();
      const cd = res.headers.get('Content-Disposition') || '';
      const match = cd.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
      const serverName = match ? decodeURIComponent((match[1] || match[2] || '').trim()) : '';
      const ts   = new Date().toISOString().replace(/[:.]/g,'');
      // Universal zoom naming (matches server _download_name / zoom badge)
      const inverseZoom = 21 - usedZoom;
      const prefix = `z${inverseZoom}_`;
      const defaultName = total>1 ? `${prefix}export_${system}_${ts}_${partSuffix}.tif` : `${prefix}export_${system}_${ts}.tif`;
      const finalName   = serverName || `${prefix}${partName}.tif` || defaultName;

      console.log(`[Export] Part ${i+1}/${total} - File Download:`, {
        serverFilename: serverName || '(not provided)',
        finalFilename: finalName,
        blobSize: blob.size,
        downloadStarted: true
      });

      downloadBlob(blob, finalName);
      completed++;
      partResults.push({ bbox: partBbox, finalName });
      console.log(`[Export] Part ${i+1}/${total} - Completed (${completed}/${total})`);
    } catch (err) {
      console.error(`[Export] Part ${i+1}/${total} - Error:`, {
        error: err?.message || err,
        stack: err?.stack,
        partNumber: i + 1,
        totalParts: total
      });
      alert(`Network error on part ${i+1}/${total}: ` + (err?.message || err));
    }
  }

  // History overlays: overall area + per-part hover names
  const inverseZoom = 21 - usedZoom;
  const prefix = `z${inverseZoom}_`;
  const ts = new Date().toISOString().replace(/[:.]/g,'');
  const baseName = (customName ? `${prefix}${customName}.tif` : `${prefix}export_${system}_${ts}.tif`);

  if (total > 1) {
    for (const part of partResults) {
      const [pw, ps, pe, pn] = part.bbox;
      const partRect = L.rectangle([[ps, pw], [pn, pe]], {
        color: '#ff4d6d', fillColor: '#ff4d6d', fillOpacity: 0.12,
        weight: 1.5, pane: 'exportPane', interactive: true
      }).addTo(exportHistory);
      partRect.bindTooltip(part.finalName, {
        sticky: true, direction: 'top', opacity: 0.95, className: 'history-tooltip'
      });
    }
  }

  const rectBounds = [[bbox[1], bbox[0]], [bbox[3], bbox[2]]];
  const rect = L.rectangle(rectBounds, {
    color: '#ff4d6d', fillColor: '#ff4d6d', fillOpacity: total > 1 ? 0.05 : 0.2,
    weight: 2, pane: 'exportPane', interactive: total === 1
  }).addTo(exportHistory);
  const tooltip = total > 1 ? `${baseName} (${total} parts)` : (partResults[0]?.finalName || baseName);
  rect.bindTooltip(tooltip, {
    permanent: total === 1,
    sticky: total > 1,
    direction: 'center',
    className: 'history-tooltip'
  });

  console.log('[Export] ========== Export Completed ==========', {
    totalParts: total,
    completedParts: completed,
    success: completed === total,
    exportHistoryAdded: true,
    tooltip: tooltip,
    timestamp: new Date().toISOString()
  });

  btn.disabled = false;
  btn.classList.remove('busy');
  if (spinner) spinner.style.display = 'none';
  refreshSelectionLabels();
}

hgtBoxBtn?.addEventListener('click', () => {
  createOrRemoveHgtBox();
  refreshSelectionLabels();
  refreshHgtControlButton();
});

// Mobile top-right: HGT / TIF export current view (no selection box)
if (isMobileApp) {
  const mobileHgtBtn = document.getElementById('mobileHgtBtn');
  const mobileTifBtn = document.getElementById('mobileTifBtn');

  if (mobileHgtBtn && !allowedTools.includes('hgt')) {
    mobileHgtBtn.style.display = 'none';
  }

  mobileHgtBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (mobileHgtBtn.disabled) return;

    const bounds = map.getBounds();
    const south = Math.max(HGT_MIN_LAT, bounds.getSouth());
    const north = Math.min(HGT_MAX_LAT, bounds.getNorth());
    if (!(north > south)) {
      alert('Current view is outside the HGT coverage area.');
      return;
    }

    const bbox = normalizeWrappedHgtBbox([
      bounds.getWest(),
      south,
      bounds.getEast(),
      north
    ]);
    const tileCount = countHgtTilesForBbox(bbox);
    if (tileCount > HGT_EXPORT_MAX_TILES) {
      alert('This area is too large for HGT export. Zoom in and try again.');
      return;
    }

    const ok = window.confirm(
      'HGT export is a heavy download and may take a while.\n\nDo you want to continue?'
    );
    if (!ok) return;

    mobileHgtBtn.disabled = true;
    mobileHgtBtn.classList.add('busy');
    try {
      await exportHgtTiles('', bbox);
    } catch (err) {
      alert('HGT export failed: ' + (err?.message || err));
    } finally {
      mobileHgtBtn.disabled = false;
      mobileHgtBtn.classList.remove('busy');
    }
  });

  mobileTifBtn?.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (mobileTifBtn.disabled) return;
    await performGeotiffExport({ forceView: true, button: mobileTifBtn });
  });
}

// User stats functionality
const showUserStats = async () => {
  try {
    document.getElementById('userStatsModal').style.display = 'flex';
    document.getElementById('statsModalContent').innerHTML = 'Loading...';

    const res = await fetch(`${API_BASE}/user/stats`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });

    if (!res.ok) throw new Error('Failed to load stats');

    const data = await res.json();
    renderUserStats(data.stats, data.limits);
  } catch (error) {
    document.getElementById('statsModalContent').innerHTML = `<div style="color: var(--danger);">Error: ${error.message}</div>`;
  }
};

const renderUserStats = (stats, limits) => {
  const getLimitClass = (used, limit) => {
    if (limit === -1) return 'safe';
    const ratio = used / limit;
    if (ratio >= 1) return 'danger';
    if (ratio >= 0.8) return 'warning';
    return 'safe';
  };

  const getLimitPercent = (used, limit) => {
    if (limit === -1) return 0;
    return Math.min((used / limit) * 100, 100);
  };

  document.getElementById('statsModalContent').innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 20px;">
      <div style="text-align: center; padding: 16px; background: var(--card); border-radius: 8px;">
        <div style="font-size: 24px; font-weight: 600; color: var(--accent);">${stats.today}</div>
        <div style="font-size: 12px; color: var(--muted);">Today</div>
      </div>
      <div style="text-align: center; padding: 16px; background: var(--card); border-radius: 8px;">
        <div style="font-size: 24px; font-weight: 600; color: var(--accent);">${stats.week}</div>
        <div style="font-size: 12px; color: var(--muted);">This Week</div>
      </div>
      <div style="text-align: center; padding: 16px; background: var(--card); border-radius: 8px;">
        <div style="font-size: 24px; font-weight: 600; color: var(--accent);">${stats.month}</div>
        <div style="font-size: 12px; color: var(--muted);">This Month</div>
      </div>
      <div style="text-align: center; padding: 16px; background: var(--card); border-radius: 8px;">
        <div style="font-size: 24px; font-weight: 600; color: var(--accent);">${stats.total}</div>
        <div style="font-size: 12px; color: var(--muted);">All Time</div>
      </div>
    </div>

    <h4 style="margin: 20px 0 12px 0; color: var(--text);">📊 Export Limits</h4>

    <div class="limit-indicator">
      <span>Daily</span>
      <div class="limit-bar">
        <div class="limit-fill ${getLimitClass(limits.day.used, limits.day.limit)}"
             style="width: ${getLimitPercent(limits.day.used, limits.day.limit)}%"></div>
      </div>
      <span>${limits.day.used}${limits.day.limit === -1 ? '' : '/' + limits.day.limit}</span>
    </div>

    <div class="limit-indicator">
      <span>Weekly</span>
      <div class="limit-bar">
        <div class="limit-fill ${getLimitClass(limits.week.used, limits.week.limit)}"
             style="width: ${getLimitPercent(limits.week.used, limits.week.limit)}%"></div>
      </div>
      <span>${limits.week.used}${limits.week.limit === -1 ? '' : '/' + limits.week.limit}</span>
    </div>

    <div class="limit-indicator">
      <span>Monthly</span>
      <div class="limit-bar">
        <div class="limit-fill ${getLimitClass(limits.month.used, limits.month.limit)}"
             style="width: ${getLimitPercent(limits.month.used, limits.month.limit)}%"></div>
      </div>
      <span>${limits.month.used}${limits.month.limit === -1 ? '' : '/' + limits.month.limit}</span>
    </div>

    ${stats.recent?.length ? `
      <h4 style="margin: 20px 0 12px 0; color: var(--text);">📅 Recent Exports</h4>
      <div style="max-height: 150px; overflow-y: auto;">
        ${stats.recent.slice(0, 5).map(exp => `
          <div style="display: flex; justify-content: space-between; padding: 8px 12px; background: var(--card); border-radius: 6px; margin: 4px 0;">
            <span>${exp.date}</span>
            <span>${exp.base.toUpperCase()}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}

    ${Object.keys(stats.base_usage || {}).length ? `
      <h4 style="margin: 20px 0 12px 0; color: var(--text);">Favorite Base Maps</h4>
      ${Object.entries(stats.base_usage).map(([base, count]) => `
        <div style="display: flex; justify-content: space-between; padding: 4px 0;">
          <span>${base.toUpperCase()}</span>
          <span>${count} exports</span>
        </div>
      `).join('')}
    ` : ''}
  `;
};

const closeStatsModal = () => {
  document.getElementById('userStatsModal').style.display = 'none';
};

// Close modal on outside click
document.getElementById('userStatsModal').addEventListener('click', (e) => {
  if (e.target.id === 'userStatsModal') closeStatsModal();
});

// Attach event listeners after functions are defined
document.getElementById('statsBtn').addEventListener('click', showUserStats);
document.getElementById('closeStatsBtn').addEventListener('click', closeStatsModal);

initSettingsController({
  userRef: () => user,
  setUser: (nextUser) => { user = nextUser; },
  getToken: () => token,
  API_BASE,
  allowedBases,
  allowedOver,
  map,
  baseSelect,
  seamarksCb,
  openaipCb,
  densityCb,
  historyToggle,
  getIsNamesOverlayEnabled: () => isNamesOverlayEnabled,
  setIsNamesOverlayEnabled: (next) => { isNamesOverlayEnabled = next; },
  shouldShowNamesOverlayForBase: (baseType) => (
    allowedOver.includes('label') && !baseHasNames(baseType) && supportsNamesOverlay(baseType)
  ),
  applyNamesOverlayForBase,
  setAttrib,
  updateOverlayButtonStates,
  exportSystem,
  exportQuality,
  setRulerUnits: (next) => { rulerUnits = next; },
  updateRulerLabels,
  hasRulerPoints: () => rulerPoints.length > 1,
  updateDensityOpacity,
  updateDensityBorderColors,
  populateFavoriteSelects,
  loadFavorites,
  applyFavorites,
}).init();

// Toolbar behavior moved to source_code/frontend/toolbar/toolbar.js

function setupTourControlIds() {
  // Keep optional selectors stable for onboarding without changing behavior.
  const potentialSearchControl = document.querySelector(
    '.leaflet-control-geocoder, .leaflet-control-locate, .leaflet-control-search, [data-control="search"]'
  );
  if (potentialSearchControl && !potentialSearchControl.id) {
    potentialSearchControl.id = 'searchControl';
  }
}

async function runOnboardingTour(options = {}) {
  const { showFailureNotice = false } = options;
  const started = await startOnboardingTour({
    userId: user?.id ?? null,
    onboardingResetVersion: Number(user?.onboarding_reset_version || 0),
    allowedBases,
    allowedOverlays: allowedOver,
    allowedTools,
    onFinished: () => {
      // Keep Leaflet stable after overlay teardown.
      map.invalidateSize();
    }
  });

  if (!started && showFailureNotice) {
    alert('Tutorial is temporarily unavailable. Please try again later.');
  }
}

const helpTourBtn = document.getElementById('helpTourBtn');
helpTourBtn?.addEventListener('click', () => {
  const settingsModal = document.getElementById('userSettingsModal');
  if (settingsModal?.style.display === 'flex') {
    document.body.classList.remove('settings-modal-open');
    settingsModal.style.display = 'none';
  }
  runOnboardingTour({ showFailureNotice: true });
});

// Start the tour once for first-time users after controls finish rendering.
// Mobile has a different chrome; skip auto tour there (Help still works).
setupTourControlIds();
map.whenReady(() => {
  setTimeout(() => {
    if (isMobileApp) return;
    if (!shouldAutoStartOnboardingTour(user?.id ?? null, Number(user?.onboarding_reset_version || 0))) return;
    runOnboardingTour();
  }, 350);
});
