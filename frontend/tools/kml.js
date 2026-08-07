/** User KML import → DB-backed overlays with style + on/off toggle. */

import { iconHtml } from '../toolbar/icons.js?v=20260806t';

const DEFAULT_COLOR = '#4de2ff';
const DEFAULT_OPACITY = 0.65;
let toGeoJsonKml = null;

async function loadKmlConverter() {
  if (toGeoJsonKml) return toGeoJsonKml;
  const mod = await import('https://cdn.jsdelivr.net/npm/@tmcw/togeojson@5.8.1/+esm');
  toGeoJsonKml = mod.kml;
  return toGeoJsonKml;
}

function parseKmlToGeoJSON(kmlText) {
  const dom = new DOMParser().parseFromString(kmlText, 'text/xml');
  const err = dom.querySelector('parsererror');
  if (err) throw new Error('Invalid KML XML');
  return loadKmlConverter().then((kmlFn) => kmlFn(dom));
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

function styleFromItem(item) {
  const color = item?.color || DEFAULT_COLOR;
  const opacity = Number.isFinite(item?.opacity) ? item.opacity : DEFAULT_OPACITY;
  return {
    color,
    weight: 2,
    opacity: Math.max(0.25, Math.min(1, opacity + 0.2)),
    fillColor: color,
    fillOpacity: Math.max(0, Math.min(0.55, opacity * 0.35)),
  };
}

function pointStyleFromItem(item) {
  const base = styleFromItem(item);
  return {
    radius: 6,
    color: base.color,
    weight: 2,
    fillColor: base.color,
    fillOpacity: Math.max(0.35, Math.min(0.85, (item?.opacity ?? DEFAULT_OPACITY) * 0.85)),
    opacity: base.opacity,
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
      <div class="kml-panel-hint">Import a .kml file, then toggle it on the map.</div>
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
    fileInput.accept = '.kml,application/vnd.google-earth.kml+xml,application/xml,text/xml';
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
      toggle.style.borderColor = active ? item.color : '';
      toggle.style.color = active ? item.color : '';
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
      sub.textContent = `${kb} KB · ${Math.round(item.opacity * 100)}%`;
      meta.appendChild(nameEl);
      meta.appendChild(sub);

      const swatch = document.createElement('span');
      swatch.className = 'kml-swatch';
      swatch.style.background = item.color;
      swatch.title = item.color;

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

      actions.appendChild(swatch);
      actions.appendChild(fitBtn);
      actions.appendChild(delBtn);
      row.appendChild(toggle);
      row.appendChild(meta);
      row.appendChild(actions);
      listEl.appendChild(row);
    });
  }

  function applyLayerStyle(layer, item) {
    if (!layer) return;
    const lineStyle = styleFromItem(item);
    const pointStyle = pointStyleFromItem(item);
    layer.eachLayer((sub) => {
      if (typeof sub.setStyle === 'function') {
        if (sub instanceof L.CircleMarker) sub.setStyle(pointStyle);
        else sub.setStyle(lineStyle);
      }
    });
  }

  function buildLayer(geojson, item) {
    const lineStyle = styleFromItem(item);
    const pointStyle = pointStyleFromItem(item);
    return L.geoJSON(geojson, {
      style: () => ({ ...lineStyle }),
      pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { ...pointStyle }),
      onEachFeature: (feature, layer) => {
        const name = feature?.properties?.name || feature?.properties?.Name;
        const desc = feature?.properties?.description || feature?.properties?.Description;
        if (name || desc) {
          const html = `<strong>${escapeHtml(name || 'Feature')}</strong>${
            desc ? `<div style="margin-top:4px">${escapeHtml(String(desc).slice(0, 400))}</div>` : ''
          }`;
          layer.bindPopup(html);
        }
      },
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
      const geojson = await parseKmlToGeoJSON(data.content);
      const layer = buildLayer(geojson, merged);
      layer.addTo(map);
      if (fit) {
        try {
          const b = layer.getBounds?.();
          if (b && b.isValid()) map.fitBounds(b.pad(0.08));
        } catch (_) {
          /* ignore */
        }
      }
      activeLayers.set(kmlId, layer);
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

  function fitOverlay(id) {
    const layer = activeLayers.get(Number(id));
    if (!layer) return;
    try {
      const b = layer.getBounds?.();
      if (b && b.isValid()) map.fitBounds(b.pad(0.08));
    } catch (_) {
      /* ignore */
    }
  }

  async function updateStyle(id, patch = {}) {
    const kmlId = Number(id);
    const item = findItem(kmlId);
    if (!item) throw new Error('KML not found');

    const body = {};
    if (patch.name != null) body.name = String(patch.name).trim().slice(0, 120);
    if (patch.color != null) body.color = patch.color;
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

  async function uploadFile(file) {
    if (!file) return null;
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('name', file.name);
    try {
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
    onChange(fn) {
      if (typeof fn === 'function') listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
