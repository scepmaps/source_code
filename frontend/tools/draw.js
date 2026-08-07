/**
 * Desktop-only map drawing tool.
 * - Toolbar icon expands into a maps-style grid of shape tools + quick colors.
 * - Right-click on the map opens a floating picker to start a shape at that location.
 * - Freehand mode draws while the mouse button is held.
 */

import { iconHtml } from '../toolbar/icons.js?v=20260807m';

const COLOR_PRESETS = [
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
  { id: 'polygon', label: 'Polygon', icon: 'polygon' },
  { id: 'rectangle', label: 'Rectangle', icon: 'box' },
  { id: 'circle', label: 'Circle', icon: 'circle' },
];

export function initDrawTool({
  map,
  isMobile = false,
  onActivate = null,
  onDeactivate = null,
  enableMapCursor = null,
} = {}) {
  if (isMobile || !map) {
    return {
      bindButton() {},
      closePanel() {},
      isOpen: () => false,
      isActive: () => false,
      cancel: () => false,
      deactivate() {},
    };
  }

  const drawn = L.featureGroup().addTo(map);
  let btnEl = null;
  let panelEl = null;
  let menuEl = null;
  let drawColor = COLOR_PRESETS[0];
  let activeMode = null;
  let drafting = null;
  let preview = null;
  let vertexMarkers = [];
  let selectedLayer = null;
  let menuLatLng = null;
  let suppressMapClickUntil = 0;
  let ignoreDocClickUntil = 0;
  let mapDraggingWasEnabled = true;

  function pathStyle(extra = {}, color = drawColor) {
    return {
      color,
      weight: 2.25,
      opacity: 0.95,
      fillColor: color,
      fillOpacity: 0.18,
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
      color: '#fff',
      weight: 1.5,
      fillColor: drawColor,
      fillOpacity: 1,
      pane: 'selectionPane',
      interactive: false,
    }).addTo(map);
    vertexMarkers.push(m);
    return m;
  }

  function selectLayer(layer) {
    if (selectedLayer && selectedLayer !== layer) {
      try {
        const c = layerColor(selectedLayer);
        if (selectedLayer instanceof L.CircleMarker) {
          selectedLayer.setStyle({
            color: '#fff',
            weight: 1.5,
            fillColor: c,
            fillOpacity: 0.95,
          });
        } else {
          selectedLayer.setStyle?.(
            pathStyle(
              selectedLayer instanceof L.Polyline && !(selectedLayer instanceof L.Polygon)
                ? { fillOpacity: 0 }
                : {},
              c
            )
          );
        }
      } catch (_) {
        /* ignore */
      }
    }
    selectedLayer = layer || null;
    if (!selectedLayer) return;
    const c = layerColor(selectedLayer);
    try {
      if (selectedLayer instanceof L.CircleMarker) {
        selectedLayer.setStyle({
          color: '#fff',
          weight: 2.5,
          fillColor: c,
          fillOpacity: 1,
          radius: 7,
        });
      } else {
        selectedLayer.setStyle?.(
          pathStyle(
            {
              weight: 3,
              fillOpacity:
                selectedLayer instanceof L.Polyline && !(selectedLayer instanceof L.Polygon)
                  ? 0
                  : 0.28,
            },
            c
          )
        );
      }
    } catch (_) {
      /* ignore */
    }
  }

  function commitLayer(layer) {
    if (!layer) return;
    layer._scepDrawColor = drawColor;
    drawn.addLayer(layer);
    layer.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      selectLayer(layer);
    });
    selectLayer(layer);
    clearPreview();
    drafting = null;
    setDraftInteractions(false);
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
    refreshColorActive();
    if (selectedLayer) {
      const layer = selectedLayer;
      selectedLayer = null;
      selectLayer(layer);
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
      commitLayer(L.polyline(points, pathStyle({ fillOpacity: 0, weight: 2.75, lineCap: 'round', lineJoin: 'round' })));
      return;
    }
    if (mode === 'line') {
      if (points.length < 2) {
        cancelDraft();
        return;
      }
      commitLayer(L.polyline(points, pathStyle({ fillOpacity: 0 })));
      return;
    }
    if (mode === 'polygon') {
      if (points.length < 3) {
        cancelDraft();
        return;
      }
      commitLayer(L.polygon(points, pathStyle()));
      return;
    }
    if (mode === 'rectangle' && points.length >= 2) {
      commitLayer(L.rectangle(L.latLngBounds(points[0], points[1]), pathStyle()));
      return;
    }
    if (mode === 'circle' && center && points.length >= 1) {
      const radius = map.distance(center, points[0]);
      if (radius > 0) commitLayer(L.circle(center, { ...pathStyle(), radius }));
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
        color: '#fff',
        weight: 1.5,
        fillColor: drawColor,
        fillOpacity: 0.95,
        pane: 'selectionPane',
      });
      commitLayer(marker);
      return;
    }

    if (mode === 'freehand') {
      // Freehand starts on mousedown, not a single click placement.
      return;
    }

    if (mode === 'line' || mode === 'polygon') {
      drafting = { mode, points: [latlng] };
      addVertexMarker(latlng);
      setDraftInteractions(true);
      return;
    }

    if (mode === 'rectangle') {
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
      return;
    }

    if (mode === 'rectangle') {
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
            weight: mode === 'freehand' ? 2.75 : 2.25,
            lineCap: 'round',
            lineJoin: 'round',
          })
        ).addTo(map);
      } else preview.setLatLngs(latlngs);
      return;
    }

    if (mode === 'polygon') {
      const latlngs = points.concat([latlng]);
      if (latlngs.length < 2) return;
      if (!preview) {
        preview = L.polygon(latlngs, pathStyle({ dashArray: '6,6', opacity: 0.7 })).addTo(map);
      } else preview.setLatLngs(latlngs);
      return;
    }

    if (mode === 'rectangle' && points[0]) {
      const bounds = L.latLngBounds(points[0], latlng);
      if (!preview) {
        preview = L.rectangle(bounds, pathStyle({ dashArray: '6,6', opacity: 0.7 })).addTo(map);
      } else preview.setBounds(bounds);
      return;
    }

    if (mode === 'circle' && center) {
      const radius = map.distance(center, latlng);
      if (!preview) {
        preview = L.circle(center, { ...pathStyle({ dashArray: '6,6', opacity: 0.7 }), radius }).addTo(map);
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

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = 'drawPickerPanel';
    panelEl.className = 'rail-panel draw-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'Drawing tools');

    const colorSwatches = COLOR_PRESETS.map(
      (c) =>
        `<button type="button" class="draw-color-swatch" data-color="${c}" title="${c}" aria-label="Color ${c}" style="--swatch:${c}"></button>`
    ).join('');

    panelEl.innerHTML = `
      ${MODES.map(modeButtonHtml).join('')}
      <div class="draw-panel-footer">
        <div class="draw-color-row" aria-label="Draw color">${colorSwatches}</div>
        <button type="button" class="draw-panel-clear" id="drawClearBtn" title="Clear drawings">Clear</button>
      </div>
      <div class="draw-panel-hint">Hold-click to freehand. Right-click the map to add a shape.</div>
    `;

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

    panelEl.addEventListener('click', (e) => e.stopPropagation());
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
    menuEl.style.top = `${Math.min(window.innerHeight - 260, Math.max(8, y))}px`;
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
    // Freehand is hold-to-draw; ignore click placement.
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
    if (!panelEl?.classList.contains('open')) return;
    if (panelEl.contains(e.target) || btnEl?.contains(e.target)) return;
    closePanel();
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

  // If the pointer is released outside the map while freehanding, still finish.
  document.addEventListener('mouseup', (e) => {
    if (!drafting || drafting.mode !== 'freehand') return;
    finishDraft();
    restoreMapDragging();
  });

  function deactivate() {
    cancelDraft();
    activeMode = null;
    closeMapMenu();
    closePanel();
    setCursor(false);
    refreshPanelActive();
    notifyDeactivate();
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
  };
}
