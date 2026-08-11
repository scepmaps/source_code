const TOUR_SEEN_KEY_PREFIX = 'scepmaps_onboarding_seen_v3';
const DRIVER_CSS_ID = 'driverjs-css';
const DRIVER_SCRIPT_ID = 'driverjs-script';
const TOUR_ZOOM_CONTROL_ID = 'zoomControls';
/** Auto-start the tutorial at most this many times (close or finish both count). */
const AUTO_SHOW_LIMIT = 2;

function isElementVisible(el) {
  if (!el) return false;
  if (el.hasAttribute('hidden')) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }
  return el.getClientRects().length > 0;
}

function ensureZoomControlId() {
  const zoomControl = document.querySelector('.leaflet-control-zoom');
  if (zoomControl && !zoomControl.id) {
    zoomControl.id = TOUR_ZOOM_CONTROL_ID;
  }
}

function ensureDriverCssLoaded() {
  if (document.getElementById(DRIVER_CSS_ID)) return;
  const link = document.createElement('link');
  link.id = DRIVER_CSS_ID;
  link.rel = 'stylesheet';
  link.href = 'https://cdn.jsdelivr.net/npm/driver.js@1.3.6/dist/driver.css';
  document.head.appendChild(link);
}

function ensureDriverScriptLoaded() {
  return new Promise((resolve, reject) => {
    if (window.driver && typeof window.driver.js?.driver === 'function') {
      resolve();
      return;
    }

    const existing = document.getElementById(DRIVER_SCRIPT_ID);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed loading Driver.js')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.id = DRIVER_SCRIPT_ID;
    script.src = 'https://cdn.jsdelivr.net/npm/driver.js@1.3.6/dist/driver.js.iife.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed loading Driver.js'));
    document.head.appendChild(script);
  });
}

function hasPermission(list, value) {
  return Array.isArray(list) && list.includes(value);
}

function chartBasemapBlurb(allowedBases = []) {
  const charts = [];
  if (hasPermission(allowedBases, 'shom')) charts.push('SHOM');
  if (hasPermission(allowedBases, 'ukho')) charts.push('UKHO');
  if (hasPermission(allowedBases, 'gbsouth')) charts.push('GB South Aviation');
  if (!charts.length) return '';
  if (charts.length === 1) return ` Nautical/aviation charts include ${charts[0]}.`;
  if (charts.length === 2) return ` Nautical/aviation charts include ${charts[0]} and ${charts[1]}.`;
  const last = charts[charts.length - 1];
  return ` Nautical/aviation charts include ${charts.slice(0, -1).join(', ')}, and ${last}.`;
}

function overlayBlurb(allowedOverlays = []) {
  const labels = {
    seamarks: 'seamarks',
    openaip: 'airspace',
    label: 'name tags',
    density: 'population density',
    history: 'export history'
  };
  const names = (Array.isArray(allowedOverlays) ? allowedOverlays : [])
    .map((key) => labels[key])
    .filter(Boolean);
  if (!names.length) return 'Toggle optional map layers.';
  if (names.length === 1) return `Toggle ${names[0]}.`;
  if (names.length === 2) return `Toggle ${names[0]} and ${names[1]}.`;
  const last = names[names.length - 1];
  return `Toggle ${names.slice(0, -1).join(', ')}, and ${last}.`;
}

function buildTourStepDefinitions(context = {}) {
  const {
    allowedBases = [],
    allowedOverlays = [],
    allowedTools = [],
    isMobile = false
  } = context;

  // Edit tutorial text here: each title/description below is shown in the walkthrough.
  // Steps whose selectors are missing/hidden are skipped automatically.
  const steps = [
    {
      selector: '#map',
      popover: {
        title: 'Welcome to SCEPMAPS',
        description: isMobile
          ? 'Pan and pinch-zoom the map. Use the bottom dock for maps, overlays, tools, and settings.'
          : 'This is your map workspace. Pan, zoom, switch layers, measure, draw, and export from here.'
      }
    },
    {
      selector: `#${TOUR_ZOOM_CONTROL_ID}`,
      isEnabled: () => !isMobile,
      popover: {
        side: 'left',
        title: 'Zoom Controls',
        description: 'Use + / − to change zoom. The badge shows universal zoom (z#) used in exports. Mouse wheel and trackpad gestures also work.'
      }
    },
    {
      selector: '#btnMaps',
      popover: {
        side: isMobile ? 'top' : 'right',
        title: 'Base Maps',
        description: `Open Maps to pick a basemap (street, dark, satellite, topo, navigation, and more).${chartBasemapBlurb(allowedBases)}`
      }
    },
    {
      selector: '#btnOverlays',
      isEnabled: () => allowedOverlays.length > 0,
      popover: {
        side: isMobile ? 'top' : 'right',
        title: 'Overlays',
        description: overlayBlurb(allowedOverlays)
      }
    },
    {
      selector: '.map-tool-btn--ruler',
      popover: {
        side: isMobile ? 'top' : 'right',
        title: 'Ruler',
        description: 'Measure distances by placing points on the map. Click existing points to refine the route. Esc cancels.'
      }
    },
    {
      selector: '.map-tool-btn--box',
      isEnabled: () => !isMobile,
      popover: {
        side: 'right',
        title: 'Selection Box',
        description: 'Draw a map selection box for focused exports. Click again to remove it, or Esc to cancel while placing.'
      }
    },
    {
      selector: '.map-tool-btn--hgt',
      isEnabled: () => !isMobile && hasPermission(allowedTools, 'hgt'),
      popover: {
        side: 'right',
        title: 'HGT Elevation Box',
        description: 'Place an HGT elevation selection area for terrain exports. Limits follow the allowed HGT coverage.'
      }
    },
    {
      selector: '.map-tool-btn--draw',
      isEnabled: () => !isMobile && hasPermission(allowedTools, 'draw'),
      popover: {
        side: 'right',
        title: 'Draw',
        description: 'Annotate the map with freehand, points, lines, arrows, polygons, rectangles, and circles. Right-click opens a quick shape picker; Esc exits. Colors and measurement labels are in Settings.'
      }
    },
    {
      selector: '.map-tool-btn--kml',
      isEnabled: () => !isMobile && hasPermission(allowedTools, 'kml'),
      popover: {
        side: 'right',
        title: 'KML Overlays',
        description: 'Import KML files and toggle them on the map. Manage opacity, outline style, and name labels from Settings → KML.'
      }
    },
    {
      selector: '#cursorCoords',
      isEnabled: () => !isMobile,
      popover: {
        side: 'top',
        title: 'Cursor Coordinates',
        description: 'Move the pointer over the map to read live latitude / longitude here.'
      }
    },
    {
      selector: '#exportFilename',
      popover: {
        side: 'bottom',
        title: 'Export Filename',
        description: isMobile
          ? 'Optional download name. Leave blank to use an automatic name.'
          : 'Optional export filename. Leave blank to use an automatic name.'
      }
    },
    {
      selector: '.mobile-format-toggle',
      isEnabled: () => isMobile,
      popover: {
        side: 'bottom',
        title: 'Download Format',
        description: hasPermission(allowedTools, 'hgt')
          ? 'Choose MAP for a GeoTIFF of the current view, or HGT for elevation data.'
          : 'MAP downloads a GeoTIFF of the current map view.'
      }
    },
    {
      selector: '#mobileDownloadBtn',
      isEnabled: () => isMobile,
      popover: {
        side: 'bottom',
        title: 'Download',
        description: 'Download the current map view using the selected format and filename.'
      }
    },
    {
      selector: '#exportBtn',
      isEnabled: () => !isMobile,
      popover: {
        side: 'bottom',
        title: 'Export View',
        description: 'Export the current map view (or selection box when one is set) using your filename and quality settings.'
      }
    },
    {
      selector: '#settingsBtn',
      popover: {
        side: isMobile ? 'top' : 'bottom',
        title: 'Settings',
        description: isMobile
          ? 'Open preferences, KML imports, stats, and Help to replay this tutorial anytime.'
          : 'Open preferences, draw/KML options, export defaults, stats, and Help / Tutorial to replay this walkthrough anytime.'
      }
    }
  ];

  return steps;
}

function getExistingSteps(stepDefs) {
  return stepDefs
    .map((def) => {
      if (typeof def.isEnabled === 'function' && !def.isEnabled()) return null;
      if (!def.selector) {
        return { popover: def.popover };
      }
      const element = document.querySelector(def.selector);
      if (!isElementVisible(element)) return null;
      return { element: def.selector, popover: def.popover };
    })
    .filter(Boolean);
}

function getTourSeenStorageKey(userId = null, onboardingResetVersion = 0) {
  const normalizedUserId = userId == null ? 'anon' : String(userId);
  const normalizedVersion = Number.isFinite(Number(onboardingResetVersion)) ? Number(onboardingResetVersion) : 0;
  return `${TOUR_SEEN_KEY_PREFIX}:${normalizedUserId}:v${normalizedVersion}`;
}

/** Legacy boolean keys from v2 — treat "seen" as already at the auto limit. */
function getLegacyTourSeenStorageKey(userId = null, onboardingResetVersion = 0) {
  const normalizedUserId = userId == null ? 'anon' : String(userId);
  const normalizedVersion = Number.isFinite(Number(onboardingResetVersion)) ? Number(onboardingResetVersion) : 0;
  return `scepmaps_onboarding_seen_v2:${normalizedUserId}:v${normalizedVersion}`;
}

export function getOnboardingTourSeenCount(userId = null, onboardingResetVersion = 0) {
  const key = getTourSeenStorageKey(userId, onboardingResetVersion);
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) {
      // Migrate old boolean flag so users who already finished aren't shown twice again.
      const legacy = localStorage.getItem(getLegacyTourSeenStorageKey(userId, onboardingResetVersion));
      if (legacy === 'true') {
        localStorage.setItem(key, String(AUTO_SHOW_LIMIT));
        return AUTO_SHOW_LIMIT;
      }
      return 0;
    }
    if (raw === 'true') return AUTO_SHOW_LIMIT;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(AUTO_SHOW_LIMIT, n);
  } catch (_) {
    return AUTO_SHOW_LIMIT; // if storage fails, don't spam the tour
  }
}

function incrementOnboardingTourSeenCount(userId = null, onboardingResetVersion = 0) {
  const key = getTourSeenStorageKey(userId, onboardingResetVersion);
  const next = Math.min(AUTO_SHOW_LIMIT, getOnboardingTourSeenCount(userId, onboardingResetVersion) + 1);
  try {
    localStorage.setItem(key, String(next));
  } catch (_) {
    // ignore quota / private mode
  }
  return next;
}

export function shouldAutoStartOnboardingTour(userId = null, onboardingResetVersion = 0) {
  return getOnboardingTourSeenCount(userId, onboardingResetVersion) < AUTO_SHOW_LIMIT;
}

export function resetOnboardingTourSeenFlag(userId = null, onboardingResetVersion = 0) {
  try {
    localStorage.removeItem(getTourSeenStorageKey(userId, onboardingResetVersion));
    localStorage.removeItem(getLegacyTourSeenStorageKey(userId, onboardingResetVersion));
  } catch (_) {
    // ignore
  }
}

export async function startOnboardingTour(options = {}) {
  const {
    onFinished,
    userId = null,
    onboardingResetVersion = 0,
    allowedBases = [],
    allowedOverlays = [],
    allowedTools = [],
    isMobile = false,
    /** When true (Settings → Help), always run even if auto-limit is reached. */
    force = false,
    /** Count this run toward the auto-show limit (default true for auto + Help). */
    countTowardAutoLimit = true,
  } = options;
  try {
    if (!force && !shouldAutoStartOnboardingTour(userId, onboardingResetVersion)) {
      return false;
    }

    ensureZoomControlId();
    ensureDriverCssLoaded();
    await ensureDriverScriptLoaded();

    const stepDefs = buildTourStepDefinitions({
      allowedBases,
      allowedOverlays,
      allowedTools,
      isMobile: !!isMobile
    });
    const steps = getExistingSteps(stepDefs);
    if (!steps.length) return false;

    let counted = false;
    const markSeenOnce = () => {
      if (counted || !countTowardAutoLimit) return;
      counted = true;
      incrementOnboardingTourSeenCount(userId, onboardingResetVersion);
    };

    const driverObj = window.driver.js.driver({
      showProgress: true,
      animate: true,
      allowClose: true,
      overlayClickBehavior: 'close',
      disableActiveInteraction: true,
      doneBtnText: 'Finish',
      nextBtnText: 'Next',
      prevBtnText: 'Back',
      popoverClass: 'scepmaps-tour-popover',
      // Count close (X / overlay / Esc) and Finish toward the auto-show limit.
      // Note: if onDestroyStarted is set, Driver.js waits for driver.destroy() —
      // only use onDestroyed so close always works.
      onDestroyed: () => {
        markSeenOnce();
        if (typeof onFinished === 'function') onFinished();
      },
      steps
    });
    driverObj.drive();
    return true;
  } catch (error) {
    console.warn('[Onboarding] Guided tour is unavailable:', error);
    return false;
  }
}
