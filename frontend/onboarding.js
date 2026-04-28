const TOUR_SEEN_KEY_PREFIX = 'scepmaps_onboarding_seen_v1';
const DRIVER_CSS_ID = 'driverjs-css';
const DRIVER_SCRIPT_ID = 'driverjs-script';
const TOUR_ZOOM_CONTROL_ID = 'zoomControls';

function isElementVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
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

function buildTourStepDefinitions() {
  // Edit tutorial text here: each title/description below is shown in the walkthrough.
  return [
    {
      selector: '#map',
      popover: {
        title: 'Map View',
        description: 'This is the main map workspace where you pan, zoom, and inspect layers.'
      }
    },
    {
      selector: `#${TOUR_ZOOM_CONTROL_ID}`,
      popover: {
        title: 'Zoom Controls',
        description: 'Use + / - to change zoom. Mouse wheel and touch gestures also work.'
      }
    },
    {
      selector: '.map-tool-btn--ruler',
      popover: {
        title: 'Ruler Tool',
        description: 'Measure distances by placing points on the map. Click points to refine your route.'
      }
    },
    {
      selector: '.map-tool-btn--box',
      popover: {
        title: 'Selection Box Tool',
        description: 'Draw or remove a map selection box used for focused area operations.'
      }
    },
    {
      selector: '.map-tool-btn--hgt',
      popover: {
        title: 'HGT Tool',
        description: 'Create an HGT elevation selection area when this tool is enabled for your account.'
      }
    },
    {
      selector: '#mapBtnGroup',
      popover: {
        title: 'Base Map Selector',
        description: 'Pick the base map style here (satellite, topo, navigation, charts, and more).'
      }
    },
    {
      selector: '#overlayBtnGroup',
      popover: {
        title: 'Overlay Selector',
        description: 'Toggle overlays like seamarks, airspace, labels, density, and history.'
      }
    },
    {
      selector: '#btnShom',
      popover: {
        title: 'Nautical Charts (SHOM)',
        description: 'Switch to SHOM nautical charts when this button is available for your account.'
      }
    },
    {
      selector: '#searchControl',
      popover: {
        title: 'Search / Location',
        description: 'Use this control to jump quickly to a place or your current location.'
      }
    },
    {
      selector: '#exportBtn',
      popover: {
        title: 'Export',
        description: 'Export the current map view using your selected settings and filename.'
      }
    },
    {
      selector: '#settingsBtn',
      popover: {
        title: 'Settings Menu',
        description: 'Open your user settings, preferences, favorites, and export defaults.'
      }
    },
    {
      selector: '#helpTourBtn',
      popover: {
        title: 'Help / Tutorial',
        description: 'Use this button anytime to restart the guided tutorial.'
      }
    }
  ];
}

function getExistingSteps(stepDefs) {
  return stepDefs
    .map((def) => {
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

export function shouldAutoStartOnboardingTour(userId = null, onboardingResetVersion = 0) {
  const key = getTourSeenStorageKey(userId, onboardingResetVersion);
  return localStorage.getItem(key) !== 'true';
}

export function resetOnboardingTourSeenFlag(userId = null, onboardingResetVersion = 0) {
  const key = getTourSeenStorageKey(userId, onboardingResetVersion);
  localStorage.removeItem(key);
}

export async function startOnboardingTour(options = {}) {
  const { onFinished, userId = null, onboardingResetVersion = 0 } = options;
  try {
    ensureZoomControlId();
    ensureDriverCssLoaded();
    await ensureDriverScriptLoaded();

    const stepDefs = buildTourStepDefinitions();
    const steps = getExistingSteps(stepDefs);
    if (!steps.length) return false;

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
      onDestroyed: () => {
        const key = getTourSeenStorageKey(userId, onboardingResetVersion);
        localStorage.setItem(key, 'true');
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
