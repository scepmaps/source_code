/**
 * Desktop-only map drawing tool.
 * - Toolbar grid of shape tools + quick colors (panel stays open until re-click / Esc).
 * - Right-click opens a floating shape picker.
 * - Freehand draws while the mouse button is held.
 */

import { iconHtml } from '../toolbar/icons.js?v=20260807n';

const SETTINGS_KEY = 'scepmaps_draw_settings';
const DEFAULT_PALETTE = [
  '#4de2ff',
  '#ffd166',
  '#ff8c42',
  '#ff4d6d',
  '#7dffa0',
  '#c084fc',
  '#ffffff',
];

const MODES = [
  { id: 'freehand', label: 'Draw', icon: 'freehand' },
  { id: 'point', label: 'Point', icon: 'point' },
  { id: 'line', label: 'Line', icon: 'line' },
  { id: 'arrow', label: 'Arrow', icon: 'arrow' },
  { id: 'polygon', label: 'Polygon', icon: 'polygon' },
  { id: 'rectangle', label: 'Rectangle', icon: 'box' },
  { id: 'circle', label: 'Circle', icon: 'circle' },
];

const POLYGON_MAX_POINTS = 4;

function defaultSettings() {
  return {
    palette: [...DEFAULT_PALETTE],
    defaultColor: DEFAULT_PALETTE[0],
    showMeasurements: true,
    showCoordinates: true,
    showLength: true,
    showArea: true,
    strokeWeight: 2.25,
  };
}

function loadSettings() {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return base;
    const palette = Array.isArray(parsed.palette)
      ? parsed.palette.filter((c) => typeof c === 'string' && /^#?[0-9a-fA-F]{6}$/.test(c.replace('#', ''))).map((c) => (c.startsWith('#') ? c : `#${c}`))
      : base.palette;
    return {
      ...base,
      ...parsed,
      palette: palette.length ? palette.slice(0, 12) : base.palette,
      defaultColor: typeof parsed.defaultColor === 'string' ? parsed.defaultColor : base.defaultColor,
      strokeWeight: Number.isFinite(Number(parsed.strokeWeight)) ? Number(parsed.strokeWeight) : base.strokeWeight,
      showMeasurements: parsed.showMeasurements !== false,
      showCoordinates: parsed.showCoordinates !== false,
      showLength: parsed.showLength !== false,
      showArea: parsed.showArea !== false,
    };
  } catch (_) {
    return base;
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (_) {
    /* ignore */
  }
}

function formatMeters(meters, units = 'm') {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return '';
  switch (units) {
    case 'km':
      return `${(meters / 1000).toFixed(2)} km`;
    case 'ft':
      return `${(meters * 3.28084).toFixed(0)} ft`;
    case 'mi':
      return `${(meters * 0.000621371).toFixed(2)} mi`;
    case 'nm':
      return `${(meters * 0.000539957).toFixed(2)} nm`;
    default:
      return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters.toFixed(0)} m`;
  }
}

function formatAreaSqMeters(area, units = 'm') {
  if (typeof area !== 'number' || !Number.isFinite(area)) return '';
  if (units === 'ft' || units === 'mi') {
    const sqFt = area * 10.7639;
    if (sqFt >= 43560) return `${(sqFt / 43560).toFixed(2)} ac`;
    return `${sqFt.toFixed(0)} ft²`;
  }
  if (area >= 1e6) return `${(area / 1e6).toFixed(2)} km²`;
  if (area >= 1e4) return `${(area / 1e4).toFixed(2)} ha`;
  return `${area.toFixed(0)} m²`;
}

/** Approximate geodesic ring area (m²). */
function ringAreaSqMeters(latlngs) {
  if (!latlngs || latlngs.length < 3) return 0;
  const R = 6371000;
  let total = 0;
  for (let i = 0; i < latlngs.length; i += 1) {
    const p1 = latlngs[i];
    const p2 = latlngs[(i + 1) % latlngs.length];
    total +=
      ((p2.lng - p1.lng) * Math.PI) / 180 *
      (2 + Math.sin((p1.lat * Math.PI) / 180) + Math.sin((p2.lat * Math.PI) / 180));
  }
  return Math.abs((total * R * R) / 2);
}

function pathLength(map, latlngs) {
  let total = 0;
  for (let i = 1; i < latlngs.length; i += 1) total += map.distance(latlngs[i - 1], latlngs[i]);
  return total;
}

export function initDrawTool({
  map,
  isMobile = false,
  onActivate = null,
  onDeactivate = null,
  enableMapCursor = null,
  getUnits = () => 'm',
} = {}) {
  if (isMobile || !map) {
    return {
      bindButton() {},
      closePanel() {},
      isOpen: () => false,
      isActive: () => false,
      cancel: () => false,
      deactivate() {},
      getSettings: () => loadSettings(),
      applySettings(next = {}) {
        const merged = { ...loadSettings(), ...next };
        if (Array.isArray(next.palette) && next.palette.length) merged.palette = next.palette;
        saveSettings(merged);
      },
    };
  }

  let settings = loadSettings();
  const drawn = L.featureGroup().addTo(map);
  let btnEl = null;
  let panelEl = null;
  let menuEl = null;
  let drawColor = settings.defaultColor || settings.palette[0] || DEFAULT_PALETTE[0];
  let activeMode = null;
  let drafting = null;
  let preview = null;
  let vertexMarkers = [];
  let selectedLayer = null;
  let menuLatLng = null;
  let suppressMapClickUntil = 0;
  let ignoreDocClickUntil = 0;
  let mapDraggingWasEnabled = true;

  function palette() {
    return settings.palette?.length ? settings.palette : DEFAULT_PALETTE;
  }

  function strokeWeight() {
    return Number(settings.strokeWeight) || 2.25;
  }

  function pathStyle(extra = {}, color = drawColor) {
    return {
      color,
      weight: strokeWeight(),
      opacity: 0.95,
      fillColor: color,
      fillOpacity: 0, // see-through fills
      pane: 'selectionPane',
      ...extra,
    };
  }

  function layerColor(layer) {
    return layer?._scepDrawColor || drawColor;
  }

  function setCursor(on) {
    if (typeof enableMapCursor === 'function') enableMapCursor(!!on);
    else {
      const el = map.getContainer?.();
      if (el) el.style.cursor = on ? 'crosshair' : '';
    }
  }

  function notifyActivate() {
    if (typeof onActivate === 'function') onActivate();
  }

  function notifyDeactivate() {
    if (typeof onDeactivate === 'function') onDeactivate();
  }

  function isArmed() {
    return !!activeMode || !!drafting || isOpen();
  }

  function clearPreview() {
    if (preview) {
      try {
        map.removeLayer(preview);
      } catch (_) {
        /* ignore */
      }
      preview = null;
    }
    vertexMarkers.forEach((m) => {
      try {
        map.removeLayer(m);
      } catch (_) {
        /* ignore */
      }
    });
    vertexMarkers = [];
  }

  function addVertexMarker(latlng) {
    const m = L.circleMarker(latlng, {
      radius: 4,
      color: drawColor,
      weight: 1.5,
      fillColor: drawColor,
      fillOpacity: 0,
      pane: 'selectionPane',
      interactive: false,
    }).addTo(map);
    vertexMarkers.push(m);
    return m;
  }

  function clearMeasureLabels(layer) {
    if (!layer?._scepMeasureLabels) return;
    try {
      drawn.removeLayer(layer._scepMeasureLabels);
    } catch (_) {
      try {
        map.removeLayer(layer._scepMeasureLabels);
      } catch (__) {
        /* ignore */
      }
    }
    layer._scepMeasureLabels = null;
  }

  function measureLabel(latlng, text) {
    return L.marker(latlng, {
      interactive: false,
      keyboard: false,
      pane: 'selectionPane',
      icon: L.divIcon({
        className: 'draw-measure-label',
        html: `<span>${text}</span>`,
        iconSize: null,
      }),
    });
  }

  function refreshMeasureLabels(layer) {
    clearMeasureLabels(layer);
    if (!layer || !settings.showMeasurements) return;

    const units = typeof getUnits === 'function' ? getUnits() : 'm';
    const labels = L.layerGroup();
    const kind = layer._scepDrawKind;

    if (kind === 'point' || layer instanceof L.CircleMarker) {
      const ll = layer.getLatLng?.();
      if (ll && settings.showCoordinates) {
        labels.addLayer(measureLabel(ll, `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`));
      }
    } else if (kind === 'arrow') {
      const from = layer._scepFrom;
      const to = layer._scepTo;
      if (from && to) {
        if (settings.showLength) {
          const mid = L.latLng((from.lat + to.lat) / 2, (from.lng + to.lng) / 2);
          labels.addLayer(measureLabel(mid, formatMeters(map.distance(from, to), units)));
        }
        if (settings.showCoordinates) {
          labels.addLayer(measureLabel(to, `${to.lat.toFixed(5)}, ${to.lng.toFixed(5)}`));
        }
      }
    } else if (layer instanceof L.Circle && !(layer instanceof L.CircleMarker)) {
      const c = layer.getLatLng();
      const r = layer.getRadius();
      const parts = [];
      if (settings.showLength) parts.push(`r ${formatMeters(r, units)}`);
      if (settings.showArea) parts.push(formatAreaSqMeters(Math.PI * r * r, units));
      if (parts.length) labels.addLayer(measureLabel(c, parts.join(' · ')));
      if (settings.showCoordinates) {
        labels.addLayer(
          measureLabel(
            L.latLng(c.lat - (r / 111320) * 0.15, c.lng),
            `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`
          )
        );
      }
    } else if (layer instanceof L.Polygon) {
      const latlngs = layer.getLatLngs()?.[0] || layer.getLatLngs() || [];
      const ring = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
      if (settings.showArea && ring.length >= 3) {
        const center = layer.getBounds?.().getCenter?.() || ring[0];
        labels.addLayer(measureLabel(center, formatAreaSqMeters(ringAreaSqMeters(ring), units)));
      }
      if (settings.showLength && ring.length >= 2) {
        const closed = ring.concat([ring[0]]);
        const mid = ring[0];
        labels.addLayer(measureLabel(mid, formatMeters(pathLength(map, closed), units)));
      }
      if (settings.showCoordinates && ring[0]) {
        labels.addLayer(
          measureLabel(ring[0], `${ring[0].lat.toFixed(5)}, ${ring[0].lng.toFixed(5)}`)
        );
      }
    } else if (layer instanceof L.Polyline) {
      const latlngs = layer.getLatLngs() || [];
      if (settings.showLength && latlngs.length >= 2) {
        const mid = latlngs[Math.floor(latlngs.length / 2)];
        labels.addLayer(measureLabel(mid, formatMeters(pathLength(map, latlngs), units)));
      }
      if (settings.showCoordinates && latlngs[0]) {
        const last = latlngs[latlngs.length - 1];
        labels.addLayer(measureLabel(last, `${last.lat.toFixed(5)}, ${last.lng.toFixed(5)}`));
      }
    }

    if (labels.getLayers().length) {
      layer._scepMeasureLabels = labels;
      drawn.addLayer(labels);
    }
  }

  function refreshAllMeasurements() {
    drawn.eachLayer((layer) => {
      if (!layer._scepDrawColor && !layer._scepDrawKind) return;
      refreshMeasureLabels(layer);
    });
  }

  function styleLineLike(layer, color, selected) {
    layer.setStyle?.(
      pathStyle(
        {
          fillOpacity: 0,
          weight: selected ? strokeWeight() + 0.75 : strokeWeight(),
        },
        color
      )
    );
  }

  function applyLayerStyle(layer, selected = false) {
    if (!layer) return;
    const c = layerColor(layer);
    const kind = layer._scepDrawKind;

    if (kind === 'arrow' && layer.eachLayer) {
      layer.eachLayer((child) => {
        if (child instanceof L.Polygon) {
          child.setStyle(pathStyle({ fillOpacity: 0, weight: selected ? strokeWeight() + 0.5 : strokeWeight() }, c));
        } else {
          styleLineLike(child, c, selected);
        }
      });
      return;
    }

    if (layer instanceof L.CircleMarker) {
      layer.setStyle({
        color: c,
        weight: selected ? 2.5 : 1.75,
        fillColor: c,
        fillOpacity: 0,
        radius: selected ? 7 : 6,
      });
      return;
    }

    if (layer instanceof L.Polyline) {
      styleLineLike(layer, c, selected);
    }
  }

  function selectLayer(layer) {
    if (selectedLayer && selectedLayer !== layer) {
      applyLayerStyle(selectedLayer, false);
    }
    selectedLayer = layer || null;
    if (selectedLayer) applyLayerStyle(selectedLayer, true);
  }

  function arrowHeadLatLngs(from, to) {
    const p1 = map.project(from);
    const p2 = map.project(to);
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const headLen = Math.min(20, Math.max(12, len * 0.28));
    const headWidth = headLen * 0.55;
    const base = L.point(p2.x - ux * headLen, p2.y - uy * headLen);
    const left = L.point(base.x - uy * headWidth, base.y + ux * headWidth);
    const right = L.point(base.x + uy * headWidth, base.y - ux * headWidth);
    return [map.unproject(left), to, map.unproject(right)];
  }

  function createArrow(from, to, color = drawColor) {
    const line = L.polyline([from, to], pathStyle({ fillOpacity: 0 }, color));
    const head = L.polygon(arrowHeadLatLngs(from, to), pathStyle({ fillOpacity: 0 }, color));
    const group = L.featureGroup([line, head]);
    group._scepDrawKind = 'arrow';
    group._scepFrom = from;
    group._scepTo = to;
    group._scepDrawColor = color;
    return group;
  }

  function bindLayerSelect(layer) {
    const handler = (e) => {
      L.DomEvent.stopPropagation(e);
      selectLayer(layer);
    };
    if (layer.eachLayer) {
      layer.eachLayer((child) => child.on('click', handler));
    } else {
      layer.on('click', handler);
    }
  }

  function commitLayer(layer, kind = null) {
    if (!layer) return;
    layer._scepDrawColor = drawColor;
    if (kind) layer._scepDrawKind = kind;
    drawn.addLayer(layer);
    bindLayerSelect(layer);
    selectLayer(layer);
    clearPreview();
    drafting = null;
    setDraftInteractions(false);
    refreshMeasureLabels(layer);
    refreshPanelActive();
    setCursor(!!activeMode || isOpen());
  }

  function setDraftInteractions(on) {
    try {
      if (on) map.doubleClickZoom.disable();
      else map.doubleClickZoom.enable();
    } catch (_) {
      /* ignore */
    }
  }

  function restoreMapDragging() {
    if (mapDraggingWasEnabled) {
      try {
        map.dragging.enable();
      } catch (_) {
        /* ignore */
      }
    }
  }

  function cancelDraft() {
    clearPreview();
    drafting = null;
    setDraftInteractions(false);
    restoreMapDragging();
    setCursor(!!activeMode || isOpen());
    return true;
  }

  function clearAll() {
    cancelDraft();
    drawn.clearLayers();
    selectedLayer = null;
    closeMapMenu();
  }

  function deleteSelected() {
    if (!selectedLayer) return false;
    clearMeasureLabels(selectedLayer);
    try {
      drawn.removeLayer(selectedLayer);
    } catch (_) {
      /* ignore */
    }
    selectedLayer = null;
    return true;
  }

  function setDrawColor(color) {
    if (!color) return;
    drawColor = color;
    settings.defaultColor = color;
    saveSettings(settings);
    refreshColorActive();
    if (selectedLayer) {
      selectedLayer._scepDrawColor = color;
      applyLayerStyle(selectedLayer, true);
      if (selectedLayer._scepDrawKind === 'arrow' && selectedLayer._scepFrom && selectedLayer._scepTo) {
        // rebuild arrow head for color only via style
      }
      refreshMeasureLabels(selectedLayer);
    }
  }

  function finishDraft() {
    if (!drafting) return;
    const { mode, points, center } = drafting;
    if (mode === 'freehand') {
      if (points.length < 2) {
        cancelDraft();
        return;
      }
      commitLayer(
        L.polyline(
          points,
          pathStyle({ fillOpacity: 0, weight: strokeWeight() + 0.5, lineCap: 'round', lineJoin: 'round' })
        ),
        'freehand'
      );
      return;
    }
    if (mode === 'line') {
      if (points.length < 2) {
        cancelDraft();
        return;
      }
      commitLayer(L.polyline(points, pathStyle({ fillOpacity: 0 })), 'line');
      return;
    }
    if (mode === 'arrow') {
      if (points.length < 2) {
        cancelDraft();
        return;
      }
      commitLayer(createArrow(points[0], points[1]), 'arrow');
      return;
    }
    if (mode === 'polygon') {
      if (points.length < 3) {
        cancelDraft();
        return;
      }
      commitLayer(L.polygon(points, pathStyle()), 'polygon');
      return;
    }
    if (mode === 'rectangle' && points.length >= 2) {
      commitLayer(L.rectangle(L.latLngBounds(points[0], points[1]), pathStyle()), 'rectangle');
      return;
    }
    if (mode === 'circle' && center && points.length >= 1) {
      const radius = map.distance(center, points[0]);
      if (radius > 0) commitLayer(L.circle(center, { ...pathStyle(), radius }), 'circle');
      else cancelDraft();
      return;
    }
    cancelDraft();
  }

  function startModeAt(mode, latlng) {
    closeMapMenu();
    cancelDraft();
    activeMode = mode;
    refreshPanelActive();
    notifyActivate();
    setCursor(true);

    if (mode === 'point') {
      const marker = L.circleMarker(latlng, {
        radius: 6,
        color: drawColor,
        weight: 1.75,
        fillColor: drawColor,
        fillOpacity: 0,
        pane: 'selectionPane',
      });
      marker._scepDrawKind = 'point';
      commitLayer(marker, 'point');
      return;
    }

    if (mode === 'freehand') return;

    if (mode === 'line' || mode === 'polygon') {
      drafting = { mode, points: [latlng] };
      addVertexMarker(latlng);
      setDraftInteractions(true);
      return;
    }

    if (mode === 'arrow' || mode === 'rectangle') {
      drafting = { mode, points: [latlng] };
      addVertexMarker(latlng);
      return;
    }

    if (mode === 'circle') {
      drafting = { mode, center: latlng, points: [] };
      addVertexMarker(latlng);
    }
  }

  function continueDraftAt(latlng) {
    if (!drafting) return;
    const { mode } = drafting;

    if (mode === 'line' || mode === 'polygon') {
      drafting.points.push(latlng);
      addVertexMarker(latlng);
      updatePreview(latlng);
      if (mode === 'polygon' && drafting.points.length >= POLYGON_MAX_POINTS) {
        finishDraft();
      }
      return;
    }

    if (mode === 'arrow' || mode === 'rectangle') {
      drafting.points = [drafting.points[0], latlng];
      finishDraft();
      return;
    }

    if (mode === 'circle') {
      drafting.points = [latlng];
      finishDraft();
    }
  }

  function updatePreview(latlng) {
    if (!drafting) return;
    const { mode, points, center } = drafting;

    if (mode === 'freehand' || mode === 'line') {
      const latlngs = mode === 'freehand' ? points : points.concat([latlng]);
      if (!preview) {
        preview = L.polyline(
          latlngs,
          pathStyle({
            dashArray: mode === 'freehand' ? null : '6,6',
            opacity: 0.75,
            fillOpacity: 0,
            weight: mode === 'freehand' ? strokeWeight() + 0.5 : strokeWeight(),
            lineCap: 'round',
            lineJoin: 'round',
          })
        ).addTo(map);
      } else preview.setLatLngs(latlngs);
      return;
    }

    if (mode === 'arrow' && points[0]) {
      const to = latlng;
      const head = arrowHeadLatLngs(points[0], to);
      if (!preview) {
        preview = L.featureGroup([
          L.polyline([points[0], to], pathStyle({ dashArray: '6,6', opacity: 0.75, fillOpacity: 0 })),
          L.polygon(head, pathStyle({ dashArray: '6,6', opacity: 0.75, fillOpacity: 0 })),
        ]).addTo(map);
      } else {
        const layers = preview.getLayers();
        layers[0]?.setLatLngs?.([points[0], to]);
        layers[1]?.setLatLngs?.(head);
      }
      return;
    }

    if (mode === 'polygon') {
      const latlngs = points.concat([latlng]);
      if (latlngs.length < 2) return;
      if (!preview) {
        preview = L.polygon(latlngs, pathStyle({ dashArray: '6,6', opacity: 0.7, fillOpacity: 0 })).addTo(map);
      } else preview.setLatLngs(latlngs);
      return;
    }

    if (mode === 'rectangle' && points[0]) {
      const bounds = L.latLngBounds(points[0], latlng);
      if (!preview) {
        preview = L.rectangle(bounds, pathStyle({ dashArray: '6,6', opacity: 0.7, fillOpacity: 0 })).addTo(map);
      } else preview.setBounds(bounds);
      return;
    }

    if (mode === 'circle' && center) {
      const radius = map.distance(center, latlng);
      if (!preview) {
        preview = L.circle(center, { ...pathStyle({ dashArray: '6,6', opacity: 0.7, fillOpacity: 0 }), radius }).addTo(map);
      } else {
        preview.setLatLng(center);
        preview.setRadius(radius);
      }
    }
  }

  function modeButtonHtml(m) {
    return `
      <button type="button" class="rail-panel-item draw-mode-btn" data-mode="${m.id}" title="${m.label}" aria-label="${m.label}" role="menuitem">
        <span class="rail-panel-icon">${iconHtml(m.icon) || m.label}</span>
        <span class="rail-panel-name">${m.label}</span>
      </button>`;
  }

  function colorSwatchesHtml() {
    return palette()
      .map(
        (c) =>
          `<button type="button" class="draw-color-swatch" data-color="${c}" title="${c}" aria-label="Color ${c}" style="--swatch:${c}"></button>`
      )
      .join('');
  }

  function bindPanelChrome() {
    if (!panelEl) return;
    panelEl.querySelector('#drawClearBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      clearAll();
    });

    panelEl.querySelectorAll('.draw-mode-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const mode = btn.dataset.mode;
        if (activeMode === mode && !drafting) {
          activeMode = null;
          setCursor(isOpen());
          refreshPanelActive();
          return;
        }
        cancelDraft();
        activeMode = mode;
        notifyActivate();
        setCursor(true);
        refreshPanelActive();
      });
    });

    panelEl.querySelectorAll('.draw-color-swatch').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDrawColor(btn.dataset.color);
      });
    });
  }

  function rebuildPanelColors() {
    if (!panelEl) return;
    const row = panelEl.querySelector('.draw-color-row');
    if (!row) return;
    row.innerHTML = colorSwatchesHtml();
    row.querySelectorAll('.draw-color-swatch').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setDrawColor(btn.dataset.color);
      });
    });
    refreshColorActive();
  }

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = 'drawPickerPanel';
    panelEl.className = 'rail-panel draw-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'Drawing tools');

    panelEl.innerHTML = `
      ${MODES.map(modeButtonHtml).join('')}
      <div class="draw-panel-footer">
        <div class="draw-color-row" aria-label="Draw color">${colorSwatchesHtml()}</div>
        <button type="button" class="draw-panel-clear" id="drawClearBtn" title="Clear drawings">Clear</button>
      </div>
      <div class="draw-panel-hint">Hold-click to freehand. Right-click the map to add a shape. Polygon closes at 4 points.</div>
    `;

    panelEl.addEventListener('click', (e) => e.stopPropagation());
    bindPanelChrome();
    refreshColorActive();
    return panelEl;
  }

  function refreshPanelActive() {
    if (!panelEl) return;
    panelEl.querySelectorAll('.draw-mode-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === activeMode);
      btn.classList.toggle('is-active', btn.dataset.mode === activeMode);
    });
  }

  function refreshColorActive() {
    if (!panelEl) return;
    panelEl.querySelectorAll('.draw-color-swatch').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.color === drawColor);
    });
  }

  function mountPanelNearButton() {
    ensurePanel();
    if (!btnEl) return;
    let wrap = btnEl.closest('.more-btn-wrapper');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'more-btn-wrapper';
      btnEl.parentElement?.insertBefore(wrap, btnEl);
      wrap.appendChild(btnEl);
    }
    if (panelEl.parentElement !== wrap) wrap.appendChild(panelEl);
  }

  function isOpen() {
    return !!panelEl?.classList.contains('open');
  }

  function closePanel() {
    panelEl?.classList.remove('open');
    btnEl?.classList.remove('panel-open', 'map-tool-btn--active');
    btnEl?.setAttribute('aria-expanded', 'false');
    if (!activeMode && !drafting) {
      setCursor(false);
      notifyDeactivate();
    }
  }

  function openPanel() {
    mountPanelNearButton();
    document.querySelectorAll('#mapPickerPanel, #overlayPickerPanel, #moreToolDropdown, #kmlPickerPanel').forEach((el) => {
      el.classList.remove('open');
    });
    document.getElementById('btnMaps')?.classList.remove('panel-open');
    document.getElementById('btnOverlays')?.classList.remove('panel-open');
    document.getElementById('btnMaps')?.setAttribute('aria-expanded', 'false');
    document.getElementById('btnOverlays')?.setAttribute('aria-expanded', 'false');
    document.getElementById('btnKml')?.classList.remove('panel-open', 'map-tool-btn--active');
    document.getElementById('btnKml')?.setAttribute('aria-expanded', 'false');
    closeMapMenu();

    panelEl.classList.add('open');
    btnEl?.classList.add('panel-open', 'map-tool-btn--active');
    btnEl?.setAttribute('aria-expanded', 'true');
    notifyActivate();
    setCursor(true);
    refreshPanelActive();
    refreshColorActive();
  }

  function togglePanel() {
    if (isOpen()) closePanel();
    else openPanel();
  }

  function ensureMapMenu() {
    if (menuEl) return menuEl;
    menuEl = document.createElement('div');
    menuEl.id = 'drawMapMenu';
    menuEl.className = 'draw-map-menu';
    menuEl.innerHTML = `
      <div class="draw-map-menu-title">Add shape</div>
      <div class="draw-map-menu-list">
        ${MODES.map(
          (m) => `
          <button type="button" class="draw-map-menu-item" data-mode="${m.id}">
            ${iconHtml(m.icon) || ''}
            <span>${m.label}</span>
          </button>`
        ).join('')}
      </div>
    `;
    menuEl.querySelectorAll('.draw-map-menu-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const mode = btn.dataset.mode;
        const ll = menuLatLng;
        closeMapMenu();
        suppressMapClickUntil = Date.now() + 250;
        if (!ll || !mode) return;
        if (mode === 'freehand') {
          activeMode = 'freehand';
          refreshPanelActive();
          notifyActivate();
          setCursor(true);
          return;
        }
        startModeAt(mode, ll);
      });
    });
    menuEl.addEventListener('click', (e) => e.stopPropagation());
    menuEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    document.body.appendChild(menuEl);
    return menuEl;
  }

  function closeMapMenu() {
    if (!menuEl) return;
    menuEl.classList.remove('open');
    menuLatLng = null;
  }

  function openMapMenu(latlng, containerPoint) {
    ensureMapMenu();
    menuLatLng = latlng;
    const mapRect = map.getContainer().getBoundingClientRect();
    const x = mapRect.left + containerPoint.x;
    const y = mapRect.top + containerPoint.y;
    menuEl.style.left = `${Math.min(window.innerWidth - 180, Math.max(8, x))}px`;
    menuEl.style.top = `${Math.min(window.innerHeight - 280, Math.max(8, y))}px`;
    menuEl.classList.add('open');
    ignoreDocClickUntil = Date.now() + 350;
  }

  function stopMapGesture(e) {
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);
    const oe = e?.originalEvent;
    if (oe) {
      try {
        oe.stopPropagation?.();
        oe.stopImmediatePropagation?.();
      } catch (_) {
        /* ignore */
      }
    }
    ignoreDocClickUntil = Date.now() + 350;
  }

  function onMapClick(e) {
    if (Date.now() < suppressMapClickUntil) return;
    if (!isArmed() && !isOpen()) return;
    if (activeMode === 'freehand' && !drafting) return;

    if (drafting) {
      if (drafting.mode === 'freehand') return;
      stopMapGesture(e);
      continueDraftAt(e.latlng);
      return;
    }

    if (activeMode) {
      stopMapGesture(e);
      startModeAt(activeMode, e.latlng);
    }
  }

  function onMapContextMenu(e) {
    if (!isOpen() && !activeMode && !drafting) return;
    if (drafting) {
      stopMapGesture(e);
      return;
    }
    stopMapGesture(e);
    openMapMenu(e.latlng, e.containerPoint);
  }

  function onMapDblClick(e) {
    if (!drafting) return;
    if (drafting.mode === 'line' || drafting.mode === 'polygon') {
      stopMapGesture(e);
      if (drafting.points.length > 1) {
        drafting.points.pop();
        const last = vertexMarkers.pop();
        if (last) map.removeLayer(last);
      }
      finishDraft();
    }
  }

  function onMapMouseMove(e) {
    if (!drafting) return;
    if (drafting.mode === 'freehand') {
      const last = drafting.points[drafting.points.length - 1];
      if (last && map.distance(last, e.latlng) < 2) return;
      drafting.points.push(e.latlng);
      updatePreview(e.latlng);
      return;
    }
    updatePreview(e.latlng);
  }

  function onMapMouseDown(e) {
    if (activeMode !== 'freehand') return;
    if (e.originalEvent && e.originalEvent.button !== 0) return;
    if (drafting) return;
    stopMapGesture(e);
    notifyActivate();
    mapDraggingWasEnabled = map.dragging.enabled();
    try {
      map.dragging.disable();
    } catch (_) {
      /* ignore */
    }
    drafting = { mode: 'freehand', points: [e.latlng] };
    setDraftInteractions(true);
    updatePreview(e.latlng);
  }

  function onMapMouseUp(e) {
    if (!drafting || drafting.mode !== 'freehand') return;
    stopMapGesture(e);
    finishDraft();
    restoreMapDragging();
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && drafting) {
      e.preventDefault();
      finishDraft();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      if (deleteSelected()) e.preventDefault();
    }
  }

  function onDocClick(e) {
    if (Date.now() < ignoreDocClickUntil) return;
    if (menuEl?.classList.contains('open') && !menuEl.contains(e.target)) {
      closeMapMenu();
    }
    // Draw panel stays open until toolbar re-click or Esc.
  }

  function onDocContextMenu(e) {
    if (menuEl?.classList.contains('open') && !menuEl.contains(e.target)) {
      closeMapMenu();
    }
  }

  map.on('click', onMapClick);
  map.on('contextmenu', onMapContextMenu);
  map.on('dblclick', onMapDblClick);
  map.on('mousemove', onMapMouseMove);
  map.on('mousedown', onMapMouseDown);
  map.on('mouseup', onMapMouseUp);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', onDocClick);
  document.addEventListener('contextmenu', onDocContextMenu);
  document.addEventListener('mouseup', () => {
    if (!drafting || drafting.mode !== 'freehand') return;
    finishDraft();
    restoreMapDragging();
  });

  function deactivate() {
    // Clear drawing engagement but keep the panel open (sticky until re-click / Esc).
    cancelDraft();
    activeMode = null;
    closeMapMenu();
    refreshPanelActive();
    setCursor(isOpen());
    if (!isOpen()) notifyDeactivate();
  }

  function cancel() {
    if (menuEl?.classList.contains('open')) {
      closeMapMenu();
      return true;
    }
    if (drafting) {
      cancelDraft();
      return true;
    }
    if (activeMode) {
      activeMode = null;
      refreshPanelActive();
      setCursor(isOpen());
      if (!isOpen()) notifyDeactivate();
      return true;
    }
    if (isOpen()) {
      closePanel();
      return true;
    }
    return false;
  }

  function applySettings(next) {
    settings = { ...defaultSettings(), ...settings, ...next };
    if (Array.isArray(next?.palette) && next.palette.length) {
      settings.palette = next.palette;
    }
    saveSettings(settings);
    if (settings.defaultColor) drawColor = settings.defaultColor;
    else if (!palette().includes(drawColor)) drawColor = palette()[0];
    rebuildPanelColors();
    refreshColorActive();
    refreshAllMeasurements();
    if (selectedLayer) applyLayerStyle(selectedLayer, true);
  }

  return {
    bindButton(btn) {
      btnEl = btn;
      if (!btnEl) return;
      btnEl.setAttribute('aria-haspopup', 'true');
      btnEl.setAttribute('aria-expanded', 'false');
      mountPanelNearButton();
      btnEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePanel();
      });
    },
    closePanel,
    isOpen,
    isActive: () => isArmed() || isOpen(),
    cancel,
    deactivate,
    clearAll,
    getSettings: () => ({ ...settings, palette: [...palette()] }),
    applySettings,
  };
}
