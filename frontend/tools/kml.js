/** User KML import → DB-backed overlays with style + on/off toggle. */

import { iconHtml } from '../toolbar/icons.js?v=20260806t';
import {
  parseKmlText,
  parseKmlFile,
  pathStyleFromFeature,
  pointStyleFromFeature,
  summarizeStats,
} from './kml-parse.js?v=20260807h';

const DEFAULT_COLOR = '#4de2ff';
const DEFAULT_OPACITY = 0.65;
const RED_OUTLINE_KEY = 'scepmaps_kml_red_outline';
const RED_OUTLINE_COLOR = '#ff1f1f';

function readRedOutlinePref() {
  try {
    return localStorage.getItem(RED_OUTLINE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function authHeaders(token) {
  return { Authorization: 'Bearer ' + token };
}

function normalizeItem(raw = {}) {
  const opacity = Number(raw.opacity);
  return {
    id: Number(raw.id),
    name: raw.name || `KML #${raw.id}`,
    created_at: Number(raw.created_at) || 0,
    size_bytes: Number(raw.size_bytes) || 0,
    color: typeof raw.color === 'string' && raw.color.startsWith('#') ? raw.color : DEFAULT_COLOR,
    opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : DEFAULT_OPACITY,
    enabled: !!raw.enabled,
  };
}

export function initKmlOverlays({ map, getToken, API_BASE = '' }) {
  const activeLayers = new Map(); // id -> L.Layer
  let items = [];
  let panelEl = null;
  let listEl = null;
  let fileInput = null;
  let btnEl = null;
  let bootstrapped = false;
  let redOutline = readRedOutlinePref();
  const listeners = new Set();

  function notify() {
    listeners.forEach((fn) => {
      try {
        fn(getItems());
      } catch (_) {
        /* ignore */
      }
    });
  }

  function getItems() {
    return items.map((item) => ({
      ...item,
      active: activeLayers.has(item.id),
    }));
  }

  function findItem(id) {
    return items.find((x) => x.id === Number(id));
  }

  function upsertItem(raw) {
    const next = normalizeItem(raw);
    const idx = items.findIndex((x) => x.id === next.id);
    if (idx >= 0) items[idx] = { ...items[idx], ...next };
    else items.unshift(next);
    return findItem(next.id);
  }

  async function api(path, opts = {}) {
    const token = typeof getToken === 'function' ? getToken() : '';
    const headers = {
      ...(opts.headers || {}),
      ...authHeaders(token),
    };
    if (opts.body && !(opts.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function ensurePanel() {
    if (panelEl) return panelEl;

    panelEl = document.createElement('div');
    panelEl.id = 'kmlPickerPanel';
    panelEl.className = 'rail-panel kml-panel';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'KML overlays');

    panelEl.innerHTML = `
      <div class="kml-panel-header">
        <span class="kml-panel-title">KML overlays</span>
        <button type="button" class="kml-panel-upload" id="kmlUploadBtn" title="Import KML">
          ${iconHtml('upload') || '＋'} Import
        </button>
      </div>
      <div class="kml-panel-list" id="kmlPanelList"></div>
      <div class="kml-panel-hint">Import a .kml or .kmz file, then toggle it on the map.</div>
    `;

    listEl = panelEl.querySelector('#kmlPanelList');
    panelEl.querySelector('#kmlUploadBtn')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      pickFile();
    });
    panelEl.addEventListener('click', (e) => e.stopPropagation());

    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept =
      '.kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/xml,text/xml,application/zip';
    fileInput.style.display = 'none';
    document.body.appendChild(fileInput);
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) await uploadFile(file);
    });

    return panelEl;
  }

  function pickFile() {
    ensurePanel();
    fileInput?.click();
  }

  function mountPanelNearButton() {
    ensurePanel();
    if (!btnEl) return;
    const isMobile = document.body.classList.contains('mobile-app');
    if (isMobile) {
      const host = document.getElementById('mobileSheetHost') || document.body;
      if (panelEl.parentElement !== host) host.appendChild(panelEl);
      return;
    }
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
    if (document.body.classList.contains('mobile-app')) {
      document.body.classList.remove('mobile-sheet-open');
      const backdrop = document.getElementById('mobileSheetBackdrop');
      if (backdrop) backdrop.hidden = true;
    }
  }

  function openPanel() {
    mountPanelNearButton();
    document.querySelectorAll('#mapPickerPanel, #overlayPickerPanel, #moreToolDropdown').forEach((el) => {
      el.classList.remove('open');
    });
    document.getElementById('btnMaps')?.classList.remove('panel-open');
    document.getElementById('btnOverlays')?.classList.remove('panel-open');
    document.getElementById('btnMaps')?.setAttribute('aria-expanded', 'false');
    document.getElementById('btnOverlays')?.setAttribute('aria-expanded', 'false');

    panelEl.classList.add('open');
    btnEl?.classList.add('panel-open', 'map-tool-btn--active');
    btnEl?.setAttribute('aria-expanded', 'true');

    if (document.body.classList.contains('mobile-app')) {
      document.body.classList.add('mobile-sheet-open');
      const backdrop = document.getElementById('mobileSheetBackdrop');
      if (backdrop) backdrop.hidden = false;
    }
    refreshList();
  }

  function togglePanel() {
    if (isOpen()) closePanel();
    else openPanel();
  }

  async function refreshList() {
    ensurePanel();
    if (listEl) listEl.innerHTML = '<div class="kml-panel-empty">Loading…</div>';
    try {
      const data = await api('/api/kml');
      items = (data.items || []).map(normalizeItem);
      // Keep session active state in sync with list
      for (const item of items) {
        if (item.enabled && !activeLayers.has(item.id)) {
          // defer until bootstrap; don't auto-load here every refresh
        }
      }
      renderList();
      notify();
      return items;
    } catch (err) {
      if (listEl) listEl.innerHTML = `<div class="kml-panel-empty">${err.message || 'Failed to load'}</div>`;
      throw err;
    }
  }

  function renderList() {
    if (!listEl) return;
    if (!items.length) {
      listEl.innerHTML = '<div class="kml-panel-empty">No KML files yet</div>';
      return;
    }

    listEl.innerHTML = '';
    items.forEach((item) => {
      const active = activeLayers.has(item.id);
      const row = document.createElement('div');
      row.className = 'kml-panel-row';
      row.dataset.kmlId = String(item.id);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'kml-toggle' + (active ? ' is-on' : '');
      toggle.style.borderColor = active ? 'var(--accent)' : '';
      toggle.style.color = active ? 'var(--accent)' : '';
      toggle.setAttribute('aria-pressed', active ? 'true' : 'false');
      toggle.title = active ? 'Hide on map' : 'Show on map';
      toggle.innerHTML = iconHtml('kml') || '';
      toggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setEnabled(item.id, !active);
      });

      const meta = document.createElement('div');
      meta.className = 'kml-panel-meta';
      const nameEl = document.createElement('div');
      nameEl.className = 'kml-panel-name';
      nameEl.textContent = item.name;
      nameEl.title = item.name;
      const sub = document.createElement('div');
      sub.className = 'kml-panel-sub';
      const kb = Math.max(1, Math.round((item.size_bytes || 0) / 1024));
      const summary = item.parse_summary ? ` · ${item.parse_summary}` : '';
      sub.textContent = `${kb} KB · ${Math.round(item.opacity * 100)}%${summary}`;
      meta.appendChild(nameEl);
      meta.appendChild(sub);

      const actions = document.createElement('div');
      actions.className = 'kml-panel-actions';

      const fitBtn = document.createElement('button');
      fitBtn.type = 'button';
      fitBtn.className = 'kml-action';
      fitBtn.title = 'Zoom to overlay';
      fitBtn.textContent = 'Fit';
      fitBtn.disabled = !active;
      fitBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fitOverlay(item.id);
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'kml-action kml-action--danger';
      delBtn.title = 'Delete';
      delBtn.innerHTML = iconHtml('trash') || '×';
      delBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!window.confirm(`Delete “${item.name}”?`)) return;
        await removeOverlay(item.id);
      });

      actions.appendChild(fitBtn);
      actions.appendChild(delBtn);
      row.appendChild(toggle);
      row.appendChild(meta);
      row.appendChild(actions);
      listEl.appendChild(row);
    });
  }

  function applyLayerStyle(layer, item) {
    if (!layer?._kmlParsed || !item) return;
    // Rebuild from KML styles so opacity / red-outline updates don't invent a flat color.
    map.removeLayer(layer);
    const next = buildLayer(layer._kmlParsed, item);
    next.addTo(map);
    activeLayers.set(Number(item.id), next);
  }

  function withRedOutline(style) {
    if (!redOutline || !style) return style;
    return {
      ...style,
      color: RED_OUTLINE_COLOR,
      weight: 1.5,
      opacity: 1,
    };
  }

  function refreshActiveStyles() {
    for (const [id, layer] of activeLayers.entries()) {
      const item = findItem(id);
      if (!item || !layer?._kmlParsed) continue;
      // Rebuild so KML-native fills stay correct while outline toggles.
      map.removeLayer(layer);
      const next = buildLayer(layer._kmlParsed, item);
      next.addTo(map);
      activeLayers.set(id, next);
    }
    notify();
  }

  function setRedOutline(on) {
    redOutline = !!on;
    try {
      localStorage.setItem(RED_OUTLINE_KEY, redOutline ? '1' : '0');
    } catch (_) {
      /* ignore */
    }
    refreshActiveStyles();
  }

  function getRedOutline() {
    return !!redOutline;
  }

  function popupHtml(feature) {
    const props = feature?.properties || {};
    const name = props.name || props.Name || '';
    if (!name) return null;
    return `<strong>${escapeHtml(name)}</strong>`;
  }

  /** Largest polygons underneath, smallest on top; lines above polys; points on top. */
  function sortFeaturesForStacking(features) {
    const rank = (feature) => {
      const t = feature?.geometry?.type || '';
      if (t === 'Point' || t === 'MultiPoint') return 3;
      if (t.includes('Line')) return 2;
      if (t.includes('Polygon') || t === 'GeometryCollection') return 1;
      return 0;
    };
    const area = (feature) => {
      const a = Number(feature?.properties?.areaM2 ?? feature?.properties?.areaKm2);
      if (Number.isFinite(a) && a > 0) {
        return feature.properties.areaM2 != null ? a : a * 1e6;
      }
      // Fallback: bbox area so unknown polygons still stack sensibly.
      try {
        const b = L.geoJSON(feature).getBounds?.();
        if (b?.isValid?.()) {
          return Math.abs((b.getEast() - b.getWest()) * (b.getNorth() - b.getSouth()));
        }
      } catch (_) {
        /* ignore */
      }
      return Number.POSITIVE_INFINITY;
    };
    return (features || []).slice().sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 1) return area(b) - area(a); // larger polygon first → drawn under smaller
      return 0;
    });
  }

  function bringSmallestPolygonsToFront(geoLayer) {
    const layers = [];
    geoLayer.eachLayer((layer) => {
      const t = layer.feature?.geometry?.type || '';
      if (!t.includes('Polygon') && t !== 'GeometryCollection') return;
      const props = layer.feature?.properties || {};
      let a = Number(props.areaM2);
      if (!Number.isFinite(a) || a <= 0) {
        a = Number(props.areaKm2);
        if (Number.isFinite(a) && a > 0) a *= 1e6;
        else a = Number.POSITIVE_INFINITY;
      }
      layers.push({ layer, area: a });
    });
    layers
      .sort((a, b) => b.area - a.area) // large first, then bringToFront smaller ones
      .forEach(({ layer }) => {
        if (typeof layer.bringToFront === 'function') layer.bringToFront();
      });
    // Lines / points above all polygons
    geoLayer.eachLayer((layer) => {
      const t = layer.feature?.geometry?.type || '';
      if (t.includes('Line') && typeof layer.bringToFront === 'function') layer.bringToFront();
    });
    geoLayer.eachLayer((layer) => {
      const t = layer.feature?.geometry?.type || '';
      if ((t === 'Point' || t === 'MultiPoint') && typeof layer.bringToFront === 'function') {
        layer.bringToFront();
      }
    });
  }

  function buildLayer(parsed, item) {
    const fallback = { color: item?.color || DEFAULT_COLOR, opacity: item?.opacity ?? DEFAULT_OPACITY };
    const group = L.featureGroup();

    const sorted = {
      type: 'FeatureCollection',
      features: sortFeaturesForStacking(parsed.geojson?.features || []),
    };

    const geoLayer = L.geoJSON(sorted, {
      style: (feature) => withRedOutline(pathStyleFromFeature(feature, fallback)),
      pointToLayer: (feature, latlng) => {
        const ps = pointStyleFromFeature(feature, fallback);
        // Ignore KML pushpin / Google Earth icon hrefs — use a clean dot marker.
        return L.circleMarker(latlng, {
          radius: Math.max(5, Math.min(8, ps.radius || 6)),
          color: '#ffffff',
          weight: 1.5,
          opacity: 0.95,
          fillColor: ps.fillColor || ps.color || fallback.color,
          fillOpacity: Math.max(0.75, Math.min(0.95, ps.fillOpacity || 0.85)),
        });
      },
      onEachFeature: (feature, layer) => {
        const html = popupHtml(feature);
        if (html) layer.bindPopup(html);
      },
    });
    bringSmallestPolygonsToFront(geoLayer);
    group.addLayer(geoLayer);

    for (const overlay of parsed.groundOverlays || []) {
      try {
        const b = overlay.bounds;
        if (!b || !overlay.href) continue;
        const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
        if (!bounds.isValid()) continue;
        const opacity = Math.max(0.05, Math.min(1, Number(overlay.opacity) || 1));
        const img = L.imageOverlay(overlay.href, bounds, {
          opacity,
          interactive: true,
          kmlOpacity: opacity,
        });
        const html = popupHtml({
          properties: { name: overlay.name, description: overlay.description },
        });
        if (html && typeof img.bindPopup === 'function') img.bindPopup(html);
        group.addLayer(img);
      } catch (_) {
        /* skip bad overlay */
      }
    }

    group._kmlStats = parsed.stats || null;
    group._kmlInventory = parsed.inventory || null;
    group._kmlParsed = parsed;
    return group;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function stripHtml(s) {
    return String(s)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+\n/g, '\n')
      .trim();
  }

  async function setOverlayActive(id, on, { persist = true, fit = false } = {}) {
    const kmlId = Number(id);
    const item = findItem(kmlId);

    if (!on) {
      const layer = activeLayers.get(kmlId);
      if (layer) {
        map.removeLayer(layer);
        activeLayers.delete(kmlId);
      }
      if (item) item.enabled = false;
      if (persist) {
        try {
          await api(`/api/kml/${kmlId}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: false }),
          });
        } catch (_) {
          /* keep local state */
        }
      }
      renderList();
      notify();
      return;
    }

    if (activeLayers.has(kmlId)) {
      if (item) item.enabled = true;
      if (persist) {
        try {
          await api(`/api/kml/${kmlId}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: true }),
          });
        } catch (_) {
          /* ignore */
        }
      }
      renderList();
      notify();
      return;
    }

    try {
      const data = await api(`/api/kml/${kmlId}`);
      const merged = upsertItem({ ...item, ...data, enabled: true });
      const parsed = await parseKmlText(data.content);
      if (!(parsed.geojson?.features?.length || parsed.groundOverlays?.length)) {
        throw new Error('No drawable geometry found in KML');
      }
      const layer = buildLayer(parsed, merged);
      layer.addTo(map);
      if (fit) fitLayerToMap(layer);
      activeLayers.set(kmlId, layer);
      if (merged && (parsed.stats || parsed.inventory)) {
        merged.parse_summary = summarizeStats(parsed.stats, parsed.inventory);
        merged.inventory = parsed.inventory || null;
      }
      if (persist) {
        try {
          await api(`/api/kml/${kmlId}`, {
            method: 'PATCH',
            body: JSON.stringify({ enabled: true }),
          });
        } catch (_) {
          /* ignore */
        }
      }
      renderList();
      notify();
    } catch (err) {
      alert(err.message || 'Failed to load KML');
      renderList();
      notify();
    }
  }

  async function setEnabled(id, on, opts = {}) {
    return setOverlayActive(id, on, { persist: true, fit: !!opts.fit, ...opts });
  }

  function refreshMapTilesAfterViewChange() {
    try {
      map.invalidateSize({ animate: false });
    } catch (_) {
      /* ignore */
    }
    map.eachLayer((lyr) => {
      try {
        if (typeof lyr.redraw === 'function') lyr.redraw();
      } catch (_) {
        /* ignore */
      }
      try {
        const gl = typeof lyr.getMaplibreMap === 'function' ? lyr.getMaplibreMap() : lyr._glMap;
        if (gl) {
          if (typeof gl.resize === 'function') gl.resize();
          if (typeof gl.triggerRepaint === 'function') gl.triggerRepaint();
        }
      } catch (_) {
        /* ignore */
      }
    });
    // Tiny pan forces some tile pipelines to request the new zoom level.
    try {
      map.panBy([1, 0], { animate: false });
      map.panBy([-1, 0], { animate: false });
    } catch (_) {
      /* ignore */
    }
  }

  function fitLayerToMap(layer) {
    if (!layer) return;
    try {
      const b = layer.getBounds?.();
      if (!b || !b.isValid()) return;
      const maxZoom = Math.min(typeof map.getMaxZoom === 'function' ? map.getMaxZoom() : 18, 15);
      map.once('moveend', () => {
        // Defer one frame so Leaflet finishes the zoom before we poke tile/GL layers.
        requestAnimationFrame(() => refreshMapTilesAfterViewChange());
      });
      map.fitBounds(b.pad(0.08), {
        animate: true,
        duration: 0.35,
        maxZoom,
        padding: [28, 28],
      });
    } catch (_) {
      /* ignore */
    }
  }

  function fitOverlay(id) {
    fitLayerToMap(activeLayers.get(Number(id)));
  }

  async function updateStyle(id, patch = {}) {
    const kmlId = Number(id);
    const item = findItem(kmlId);
    if (!item) throw new Error('KML not found');

    const body = {};
    if (patch.name != null) body.name = String(patch.name).trim().slice(0, 120);
    if (patch.opacity != null) body.opacity = Number(patch.opacity);
    if (patch.enabled != null) body.enabled = !!patch.enabled;

    const data = await api(`/api/kml/${kmlId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const updated = upsertItem({ ...item, ...(data.item || {}), id: kmlId });

    if (body.enabled === true && !activeLayers.has(kmlId)) {
      await setOverlayActive(kmlId, true, { persist: false });
    } else if (body.enabled === false && activeLayers.has(kmlId)) {
      await setOverlayActive(kmlId, false, { persist: false });
    } else if (activeLayers.has(kmlId)) {
      applyLayerStyle(activeLayers.get(kmlId), updated);
    }

    renderList();
    notify();
    return updated;
  }

  async function prepareKmlUpload(file) {
    const name = file.name || 'overlay.kml';
    const lower = name.toLowerCase();
    const isKmz =
      lower.endsWith('.kmz') ||
      file.type === 'application/vnd.google-earth.kmz' ||
      file.type === 'application/zip';
    if (isKmz) {
      const parsed = await parseKmlFile(file);
      return {
        ...parsed,
        isKmz: true,
        uploadName: name.replace(/\.kmz$/i, '.kml'),
      };
    }
    const text = await file.text();
    const parsed = await parseKmlText(text);
    return {
      ...parsed,
      kmlText: text,
      isKmz: false,
      uploadName: name.toLowerCase().endsWith('.kml') ? name : `${name}.kml`,
    };
  }

  async function uploadFile(file) {
    if (!file) return null;
    try {
      const prepared = await prepareKmlUpload(file);
      if (!(prepared.geojson?.features?.length || prepared.groundOverlays?.length)) {
        throw new Error(`No drawable geometry found in ${prepared.isKmz ? 'KMZ' : 'KML'}`);
      }

      const form = new FormData();
      const blob = new Blob([prepared.kmlText], { type: 'application/vnd.google-earth.kml+xml' });
      form.append('file', blob, prepared.uploadName);
      form.append('name', prepared.uploadName);
      const token = typeof getToken === 'function' ? getToken() : '';
      const res = await fetch(`${API_BASE}/api/kml`, {
        method: 'POST',
        headers: authHeaders(token),
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      const item = upsertItem({ ...(data.item || {}), enabled: true });
      await refreshList();
      if (item?.id) await setOverlayActive(item.id, true, { persist: true, fit: true });
      notify();
      return item;
    } catch (err) {
      alert(err.message || 'Upload failed');
      throw err;
    }
  }

  async function removeOverlay(id) {
    const kmlId = Number(id);
    try {
      await api(`/api/kml/${kmlId}`, { method: 'DELETE' });
      await setOverlayActive(kmlId, false, { persist: false });
      items = items.filter((x) => x.id !== kmlId);
      renderList();
      notify();
    } catch (err) {
      alert(err.message || 'Delete failed');
      throw err;
    }
  }

  async function bootstrap() {
    if (bootstrapped) return;
    bootstrapped = true;
    try {
      await refreshList();
      const enabledIds = items.filter((i) => i.enabled).map((i) => i.id);
      for (const id of enabledIds) {
        await setOverlayActive(id, true, { persist: false, fit: false });
      }
    } catch (_) {
      /* offline / unauthorized — ignore */
    }
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!isOpen()) return;
      if (panelEl?.contains(e.target) || btnEl?.contains(e.target)) return;
      closePanel();
    },
    true
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      closePanel();
    }
  });

  document.getElementById('mobileSheetBackdrop')?.addEventListener('click', () => {
    if (isOpen()) closePanel();
  });

  // Restore enabled overlays after login map is ready
  setTimeout(() => {
    bootstrap();
  }, 0);

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
    refreshList,
    getItems,
    setEnabled,
    updateStyle,
    uploadFile,
    pickFile,
    removeOverlay,
    fitOverlay,
    getRedOutline,
    setRedOutline,
    onChange(fn) {
      if (typeof fn === 'function') listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
