/**
 * Desktop-only map drawing tool.
 * - Toolbar icon expands into shape options (point / line / polygon / rectangle / circle).
 * - Left-click on the map opens a floating picker to start a shape at that location.
 */

import { iconHtml } from '../toolbar/icons.js?v=20260807k';

const DRAW_COLOR = '#4de2ff';
const DRAW_FILL = '#4de2ff';
const MODES = [
  { id: 'point', label: 'Point', icon: 'point' },
  { id: 'line', label: 'Line', icon: 'line' },
  { id: 'polygon', label: 'Polygon', icon: 'polygon' },
  { id: 'rectangle', label: 'Rectangle', icon: 'box' },
  { id: 'circle', label: 'Circle', icon: 'circle' },
];

function pathStyle(extra = {}) {
  return {
    color: DRAW_COLOR,
    weight: 2,
    opacity: 0.95,
    fillColor: DRAW_FILL,
    fillOpacity: 0.18,
    pane: 'selectionPane',
    ...extra,
  };
}

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
  let activeMode = null; // panel-selected mode
  let drafting = null; // in-progress shape state
  let preview = null;
  let vertexMarkers = [];
  let selectedLayer = null;
  let menuLatLng = null;
  let suppressMapClickUntil = 0;
  let ignoreDocClickUntil = 0;

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
      fillColor: DRAW_COLOR,
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
        selectedLayer.setStyle?.(pathStyle());
      } catch (_) {
        /* ignore */
      }
    }
    selectedLayer = layer || null;
    if (selectedLayer?.setStyle) {
      try {
        selectedLayer.setStyle(pathStyle({ weight: 3, fillOpacity: 0.28 }));
      } catch (_) {
        /* ignore */
      }
    }
  }

  function commitLayer(layer) {
    if (!layer) return;
    drawn.addLayer(layer);
    layer.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      selectLayer(layer);
    });
    selectLayer(layer);
    clearPreview();
    drafting = null;
    setDraftInteractions(false);
    // Keep panel mode so user can draw another of the same type.
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

  function cancelDraft() {
    clearPreview();
    drafting = null;
    setDraftInteractions(false);
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

  function finishDraft() {
    if (!drafting) return;
    const { mode, points, center } = drafting;
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
        fillColor: DRAW_COLOR,
        fillOpacity: 0.95,
        pane: 'selectionPane',
      });
      commitLayer(marker);
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

    if (mode === 'line') {
      const latlngs = points.concat([latlng]);
      if (!preview) {
        preview = L.polyline(latlngs, pathStyle({ dashArray: '6,6', opacity: 0.7, fillOpacity: 0 })).addTo(map);
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

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = 'drawPickerPanel';
    panelEl.className = 'rail-panel draw-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'Drawing tools');

    const modeButtons = MODES.map(
      (m) => `
      <button type="button" class="draw-mode-btn" data-mode="${m.id}" title="${m.label}" aria-label="${m.label}">
        ${iconHtml(m.icon) || m.label}
        <span>${m.label}</span>
      </button>`
    ).join('');

    panelEl.innerHTML = `
      <div class="draw-panel-header">
        <span class="draw-panel-title">Draw</span>
        <button type="button" class="draw-panel-clear" id="drawClearBtn" title="Clear drawings">Clear</button>
      </div>
      <div class="draw-panel-modes">${modeButtons}</div>
      <div class="draw-panel-hint">Pick a shape, or left-click the map to choose one.</div>
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

    panelEl.addEventListener('click', (e) => e.stopPropagation());
    return panelEl;
  }

  function refreshPanelActive() {
    if (!panelEl) return;
    panelEl.querySelectorAll('.draw-mode-btn').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.mode === activeMode);
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
        if (ll && mode) startModeAt(mode, ll);
      });
    });
    menuEl.addEventListener('click', (e) => e.stopPropagation());
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
    menuEl.style.top = `${Math.min(window.innerHeight - 220, Math.max(8, y))}px`;
    menuEl.classList.add('open');
    // Same gesture opens the menu; ignore the bubbling document click that would close it.
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
    // Prevent toolbar outside-click from closing the draw panel on the same gesture.
    ignoreDocClickUntil = Date.now() + 350;
  }

  function onMapClick(e) {
    if (Date.now() < suppressMapClickUntil) return;
    // Only handle when draw tool is engaged (panel open, mode selected, or drafting).
    if (!isArmed() && !isOpen()) return;

    if (drafting) {
      stopMapGesture(e);
      continueDraftAt(e.latlng);
      return;
    }

    if (activeMode) {
      stopMapGesture(e);
      startModeAt(activeMode, e.latlng);
      return;
    }

    // Draw tool active (panel open) but no mode — show picker at click.
    if (isOpen()) {
      stopMapGesture(e);
      openMapMenu(e.latlng, e.containerPoint);
    }
  }

  function onMapDblClick(e) {
    if (!drafting) return;
    if (drafting.mode === 'line' || drafting.mode === 'polygon') {
      stopMapGesture(e);
      // Remove accidental extra vertex from the second click of the dblclick.
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
    updatePreview(e.latlng);
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
    // Keep draw session if a mode is selected; only close the panel chrome.
    closePanel();
  }

  map.on('click', onMapClick);
  map.on('dblclick', onMapDblClick);
  map.on('mousemove', onMapMouseMove);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('click', onDocClick);

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
