/** User KML import → DB-backed overlays with style + on/off toggle. */

import { iconHtml } from '../toolbar/icons.js?v=20260806t';
import {
  parseKmlText,
  parseKmlFile,
  pathStyleFromFeature,
  pointStyleFromFeature,
  summarizeStats,
} from './kml-parse.js?v=20260807c';

const DEFAULT_COLOR = '#4de2ff';
const DEFAULT_OPACITY = 0.65;

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
      const summary = item.parse_summary ? ` · ${item.parse_summary}` : '';
      sub.textContent = `${kb} KB · ${Math.round(item.opacity * 100)}%${summary}`;
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
    // Settings color/opacity intentionally override embedded KML styles.
    const forced = {
      color: item?.color || DEFAULT_COLOR,
      opacity: item?.opacity ?? DEFAULT_OPACITY,
    };
    const lineStyle = {
      color: forced.color,
      weight: 2,
      opacity: Math.max(0.25, Math.min(1, forced.opacity + 0.2)),
      fillColor: forced.color,
      fillOpacity: Math.max(0, Math.min(0.55, forced.opacity * 0.35)),
    };
    const pointStyle = {
      radius: 6,
      color: forced.color,
      weight: 2,
      fillColor: forced.color,
      fillOpacity: Math.max(0.35, Math.min(0.85, forced.opacity * 0.85)),
      opacity: lineStyle.opacity,
    };
    const walk = (sub) => {
      if (sub instanceof L.ImageOverlay) {
        if (typeof sub.setOpacity === 'function') sub.setOpacity(forced.opacity);
        return;
      }
      if (
        typeof sub.eachLayer === 'function' &&
        !(sub instanceof L.Path) &&
        !(sub instanceof L.Marker) &&
        !(sub instanceof L.CircleMarker)
      ) {
        try {
          sub.eachLayer(walk);
          return;
        } catch (_) {
          /* fall through */
        }
      }
      if (typeof sub.setStyle !== 'function') return;
      if (sub instanceof L.CircleMarker) sub.setStyle(pointStyle);
      else sub.setStyle(lineStyle);
    };
    if (typeof layer.eachLayer === 'function') layer.eachLayer(walk);
  }

  function popupHtml(feature) {
    const props = feature?.properties || {};
    const name = props.name || props.Name || '';
    const folder = props._folder || '';
    const desc = props.description || props.Description || '';
    const meta = [];
    if (props.geometryKind || props.geometryType) meta.push(props.geometryKind || props.geometryType);
    if (props.areaKm2 != null) meta.push(`${props.areaKm2} km²`);
    if (props.perimeterKm != null) meta.push(`peri ${props.perimeterKm} km`);
    if (props.lengthKm != null) meta.push(`${props.lengthKm} km`);
    else if (props.lengthM != null && props.lengthM < 1000) meta.push(`${Math.round(props.lengthM)} m`);
    if (props.vertexCount != null) meta.push(`${props.vertexCount} verts`);
    if (props.altitudes?.values?.length) {
      const vals = props.altitudes.values;
      meta.push(vals.length === 1 ? `alt ${vals[0]}` : `alt ${vals[0]}–${vals[vals.length - 1]}`);
    }
    if (props.altitudeMode) meta.push(String(props.altitudeMode));
    if (props.schemaUrl) meta.push(`schema ${String(props.schemaUrl).replace(/^#/, '')}`);
    if (props.layer) meta.push(`layer ${props.layer}`);
    if (props.visibility === false) meta.push('hidden');

    if (!name && !desc && !folder && !meta.length) return null;
    const bits = [];
    if (name) bits.push(`<strong>${escapeHtml(name)}</strong>`);
    if (folder) {
      bits.push(`<div style="opacity:.7;font-size:11px;margin-top:2px">${escapeHtml(folder)}</div>`);
    }
    if (meta.length) {
      bits.push(
        `<div style="opacity:.75;font-size:11px;margin-top:4px;line-height:1.35">${escapeHtml(meta.join(' · '))}</div>`
      );
    }
    if (props.provenance?.projectId) {
      bits.push(
        `<div style="opacity:.7;font-size:11px;margin-top:3px">${escapeHtml(props.provenance.projectId)}</div>`
      );
    }
    if (desc) {
      const plain = stripHtml(String(desc)).slice(0, 500);
      if (plain) bits.push(`<div style="margin-top:4px">${escapeHtml(plain)}</div>`);
    }
    return bits.join('') || null;
  }

  function buildLayer(parsed, item) {
    const fallback = { color: item?.color || DEFAULT_COLOR, opacity: item?.opacity ?? DEFAULT_OPACITY };
    const group = L.featureGroup();

    const geoLayer = L.geoJSON(parsed.geojson || { type: 'FeatureCollection', features: [] }, {
      style: (feature) => pathStyleFromFeature(feature, fallback),
      pointToLayer: (feature, latlng) => {
        const ps = pointStyleFromFeature(feature, fallback);
        if (ps.iconHref) {
          const size = Math.round(24 * (ps.iconScale || 1));
          const icon = L.icon({
            iconUrl: ps.iconHref,
            iconSize: [size, size],
            iconAnchor: [size / 2, size / 2],
            popupAnchor: [0, -size / 2],
          });
          return L.marker(latlng, { icon, title: feature?.properties?.name || '' });
        }
        return L.circleMarker(latlng, { ...ps });
      },
      onEachFeature: (feature, layer) => {
        const html = popupHtml(feature);
        if (html) layer.bindPopup(html);
      },
    });
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
      if (fit) {
        try {
          const b = layer.getBounds?.();
          if (b && b.isValid()) map.fitBounds(b.pad(0.08));
        } catch (_) {
          /* ignore */
        }
      }
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
    onChange(fn) {
      if (typeof fn === 'function') listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
