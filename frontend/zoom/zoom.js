function ensureZoomToolLevelBadge(map) {
  const zoomControl = map.getContainer()?.querySelector('.leaflet-control-zoom');
  if (!zoomControl) return null;

  let badge = zoomControl.querySelector('.zoom-tool-level');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'zoom-tool-level';
    const zoomOutButton = zoomControl.querySelector('.leaflet-control-zoom-out');
    if (zoomOutButton) {
      zoomControl.insertBefore(badge, zoomOutButton);
    } else {
      zoomControl.appendChild(badge);
    }
  }
  return badge;
}

export function toUniversalZoom(mapZoom, maxZoom = 20) {
  // Universal / export naming: z1 = most zoomed-in (Leaflet ~20), higher = zoomed out.
  // Always keyed off Leaflet max 20 so the number matches filenames (z{21-leaflet}_…).
  const leaflet = Number(mapZoom);
  if (!Number.isFinite(leaflet)) return null;
  return (Number.isFinite(maxZoom) ? maxZoom : 20) + 1 - leaflet;
}

export function updateZoomDisplay(map, elementId = 'zoomLevel') {
  const mapZoom = map.getZoom();
  // Keep universal zoom stable across basemap maxZoom changes (OSM 19 vs imagery 20, etc.).
  const universalZoom = toUniversalZoom(mapZoom, 20);

  // Keep topbar display for compatibility with existing layout.
  const zoomLevelEl = document.getElementById(elementId);
  if (zoomLevelEl) {
    zoomLevelEl.textContent = universalZoom.toFixed(1);
  }

  // Show universal zoom on the zoom control itself.
  const badge = ensureZoomToolLevelBadge(map);
  if (badge) {
    badge.textContent = `${universalZoom.toFixed(1)}`;
    badge.title = `Zoom z${universalZoom.toFixed(1)} (Leaflet ${mapZoom.toFixed(1)})`;
  }
}

export function initZoomMechanics(map, options = {}) {
  const { onViewportSettled } = options;

  map.on('zoomend', () => {
    updateZoomDisplay(map);
    if (typeof onViewportSettled === 'function') onViewportSettled();
  });

  // Update display continuously while wheel/pinch zooming.
  map.on('zoom', () => {
    updateZoomDisplay(map);
  });

  map.on('moveend', () => {
    if (typeof onViewportSettled === 'function') onViewportSettled();
  });

  updateZoomDisplay(map);
}
