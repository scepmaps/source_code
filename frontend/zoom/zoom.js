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

export function updateZoomDisplay(map, elementId = 'zoomLevel') {
  const mapZoom = map.getZoom();
  // Use stable base max for display to avoid jumps when dynamic caps tighten/relax.
  const displayMaxZoom = Number.isFinite(map?._scepmapsDisplayMaxZoom)
    ? map._scepmapsDisplayMaxZoom
    : map.getMaxZoom();
  const maxZoom = Number.isFinite(displayMaxZoom) ? displayMaxZoom : 20;
  // Export mode is the naming/source-of-truth shown to users.
  const exportZoom = (maxZoom + 1) - mapZoom;

  // Keep topbar display for compatibility with existing layout.
  const zoomLevelEl = document.getElementById(elementId);
  if (zoomLevelEl) {
    zoomLevelEl.textContent = exportZoom.toFixed(1);
  }

  // Show current map zoom directly on the zoom control itself.
  const badge = ensureZoomToolLevelBadge(map);
  if (badge) {
    badge.textContent = `${exportZoom.toFixed(1)}`;
    badge.title = `Export mode zoom z${exportZoom.toFixed(1)} (map zoom ${mapZoom.toFixed(1)}, max ${maxZoom.toFixed(1)})`;
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
