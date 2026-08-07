export function initSettingsController(opts) {
  const {
    userRef,
    setUser,
    getToken,
    API_BASE,
    allowedBases,
    allowedOver,
    map,
    baseSelect,
    seamarksCb,
    openaipCb,
    densityCb,
    historyToggle,
    getIsNamesOverlayEnabled,
    setIsNamesOverlayEnabled,
    shouldShowNamesOverlayForBase,
    applyNamesOverlayForBase,
    setAttrib,
    updateOverlayButtonStates,
    exportSystem,
    exportQuality,
    setRulerUnits,
    updateRulerLabels,
    hasRulerPoints,
    updateDensityOpacity,
    updateDensityBorderColors,
    kmlController,
  } = opts;
  const settingsModal = document.getElementById('userSettingsModal');
  const settingsBody = settingsModal.querySelector('.stats-modal-body');
  const saveBtn = document.getElementById('savePreferencesBtn');
  const settingsOverlaysList = document.getElementById('settingsOverlaysList');
  const settingsKmlList = document.getElementById('settingsKmlList');
  let initialSettingsSnapshot = '';
  let kmlRenderToken = 0;
  /** Staged KML edits applied only on Save Changes: id -> {name,opacity,enabled} */
  const kmlDrafts = new Map();

  function bindIfExists(elementId, eventName, handler) {
    const el = document.getElementById(elementId);
    if (el) el.addEventListener(eventName, handler);
  }

  function getKmlDraftView(item) {
    const draft = kmlDrafts.get(Number(item.id)) || {};
    return {
      ...item,
      name: draft.name != null ? draft.name : item.name,
      opacity: draft.opacity != null ? draft.opacity : item.opacity,
      enabled: draft.enabled != null ? draft.enabled : !!(item.active || item.enabled),
    };
  }

  function stageKmlDraft(id, patch) {
    const key = Number(id);
    kmlDrafts.set(key, { ...(kmlDrafts.get(key) || {}), ...patch });
    refreshSaveButtonVisibility();
  }

  function collectKmlDraftsFromDom() {
    if (!settingsKmlList) return;
    settingsKmlList.querySelectorAll('.settings-kml-card').forEach((card) => {
      const id = Number(card.dataset.kmlId);
      if (!Number.isFinite(id)) return;
      const nameEl = document.getElementById(`settingsKmlName_${id}`);
      const opacityEl = document.getElementById(`settingsKmlOpacity_${id}`);
      const enabledEl = document.getElementById(`settingsKmlEnabled_${id}`);
      const patch = {};
      if (nameEl) patch.name = nameEl.value.trim();
      if (opacityEl) patch.opacity = parseFloat(opacityEl.value);
      if (enabledEl) patch.enabled = !!enabledEl.checked;
      kmlDrafts.set(id, { ...(kmlDrafts.get(id) || {}), ...patch });
    });
  }

  async function applyKmlDrafts() {
    if (!kmlController) return;
    collectKmlDraftsFromDom();
    const saved = kmlController.getItems() || [];
    for (const item of saved) {
      const draft = kmlDrafts.get(Number(item.id));
      if (!draft) continue;
      const patch = {};
      if (draft.name != null && draft.name !== item.name) patch.name = draft.name;
      if (draft.opacity != null && Number(draft.opacity) !== Number(item.opacity)) {
        patch.opacity = Number(draft.opacity);
      }
      const wasEnabled = !!(item.active || item.enabled);
      if (draft.enabled != null && !!draft.enabled !== wasEnabled) {
        patch.enabled = !!draft.enabled;
      }
      if (!Object.keys(patch).length) continue;
      await kmlController.updateStyle(item.id, patch);
    }
    kmlDrafts.clear();
  }
  const settingsOverlayDefs = [
    {
      key: 'seamarks',
      label: 'Seamarks',
      inputId: 'settingsOverlaySeamarks',
      isAvailable: () => allowedOver.includes('seamarks'),
      getChecked: () => !!seamarksCb?.checked,
      setChecked: (next) => { if (seamarksCb) seamarksCb.checked = !!next; },
    },
    {
      key: 'openaip',
      label: 'Air Space',
      inputId: 'settingsOverlayOpenaip',
      isAvailable: () => allowedOver.includes('openaip'),
      getChecked: () => !!openaipCb?.checked,
      setChecked: (next) => { if (openaipCb) openaipCb.checked = !!next; },
    },
    {
      key: 'density',
      label: 'Population Density',
      inputId: 'settingsOverlayDensity',
      isAvailable: () => allowedOver.includes('density'),
      getChecked: () => !!densityCb?.checked,
      setChecked: (next) => { if (densityCb) densityCb.checked = !!next; },
    },
    {
      key: 'label',
      label: 'Name Tags',
      inputId: 'settingsOverlayLabel',
      isAvailable: () => allowedOver.includes('label'),
      getChecked: () => !!getIsNamesOverlayEnabled?.(),
      setChecked: (next) => { if (setIsNamesOverlayEnabled) setIsNamesOverlayEnabled(!!next); },
    },
    {
      key: 'history',
      label: 'History',
      inputId: 'settingsOverlayHistory',
      isAvailable: () => allowedOver.includes('history'),
      getChecked: () => !!historyToggle?.checked,
      setChecked: (next) => { if (historyToggle) historyToggle.checked = !!next; },
    },
  ];

  function getSettingsSnapshot() {
    const fields = settingsBody.querySelectorAll('input, select, textarea');
    const state = [];
    fields.forEach((el) => {
      if (!el.id) return;
      if (el.type === 'button' || el.type === 'submit' || el.type === 'reset') return;
      if (el.type === 'checkbox' || el.type === 'radio') {
        state.push(`${el.id}:${el.checked}`);
      } else {
        state.push(`${el.id}:${el.value}`);
      }
    });
    return state.join('|');
  }

  function refreshSaveButtonVisibility() {
    const isDirty = getSettingsSnapshot() !== initialSettingsSnapshot;
    saveBtn.style.display = isDirty ? '' : 'none';
  }

  function markSettingsClean() {
    initialSettingsSnapshot = getSettingsSnapshot();
    refreshSaveButtonVisibility();
  }

  function hexToRgba(hex, opacity) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${opacity})`;
  }

  function updateBorderColorsFromInputs() {
    const borderHex = document.getElementById('settingsDensityBorderColor').value;
    const borderOpacity = parseFloat(document.getElementById('settingsDensityBorderOpacity').value);
    const hoverHex = document.getElementById('settingsDensityHoverColor').value;
    const hoverOpacity = parseFloat(document.getElementById('settingsDensityHoverOpacity').value);
    updateDensityBorderColors(hexToRgba(borderHex, borderOpacity), hexToRgba(hoverHex, hoverOpacity));
  }

  function getSelectedSettingsBase() {
    const settingsBase = document.getElementById('settingsBase');
    return settingsBase?.value || baseSelect?.value || '';
  }

  function isNamesOverlayAvailableForBase(baseType) {
    if (!allowedOver.includes('label')) return false;
    if (!shouldShowNamesOverlayForBase) return true;
    return shouldShowNamesOverlayForBase(baseType);
  }

  function getVisibleOverlayDefs(selectedBase = getSelectedSettingsBase()) {
    return settingsOverlayDefs.filter((overlayDef) => {
      if (overlayDef.key !== 'label') return overlayDef.isAvailable();
      return isNamesOverlayAvailableForBase(selectedBase);
    });
  }

  function renderOverlayOptions(selectedBase = getSelectedSettingsBase()) {
    if (!settingsOverlaysList) return;
    const checkedByKey = {};
    settingsOverlayDefs.forEach((overlayDef) => {
      const input = document.getElementById(overlayDef.inputId);
      if (input) checkedByKey[overlayDef.key] = input.checked;
    });
    if (checkedByKey.label === undefined) {
      checkedByKey.label = !!getIsNamesOverlayEnabled?.();
    }
    settingsOverlaysList.innerHTML = '';
    getVisibleOverlayDefs(selectedBase).forEach((overlayDef) => {
      const row = document.createElement('label');
      row.className = 'settings-overlay-item';
      row.innerHTML = `
        <span class="settings-overlay-label">${overlayDef.label}</span>
        <span class="settings-switch">
          <input type="checkbox" id="${overlayDef.inputId}" />
          <span class="settings-switch-slider" aria-hidden="true"></span>
        </span>
      `;
      const input = row.querySelector('input');
      if (input) {
        if (checkedByKey[overlayDef.key] !== undefined) {
          input.checked = checkedByKey[overlayDef.key];
        } else {
          input.checked = overlayDef.getChecked();
        }
      }
      settingsOverlaysList.appendChild(row);
    });
  }

  function renderKmlSettings(items) {
    if (!settingsKmlList) return;
    const token = ++kmlRenderToken;
    const list = Array.isArray(items) ? items : (kmlController?.getItems?.() || []);
    if (!list.length) {
      settingsKmlList.innerHTML = '<div class="settings-kml-empty">No KML files imported yet.</div>';
      return;
    }

    settingsKmlList.innerHTML = '';
    list.forEach((raw) => {
      if (token !== kmlRenderToken) return;
      const item = getKmlDraftView(raw);
      const card = document.createElement('div');
      card.className = 'settings-kml-card';
      card.dataset.kmlId = String(item.id);

      const top = document.createElement('div');
      top.className = 'settings-kml-card-top';

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.id = `settingsKmlName_${item.id}`;
      nameInput.className = 'settings-kml-name';
      nameInput.value = item.name || '';
      nameInput.placeholder = 'Overlay name';
      nameInput.addEventListener('input', () => {
        stageKmlDraft(item.id, { name: nameInput.value.trim() });
      });

      const onOff = document.createElement('label');
      onOff.className = 'settings-switch';
      onOff.title = 'Show on map';
      onOff.innerHTML = `
        <input type="checkbox" id="settingsKmlEnabled_${item.id}" ${item.enabled ? 'checked' : ''} />
        <span class="settings-switch-slider" aria-hidden="true"></span>
      `;
      const onOffInput = onOff.querySelector('input');
      onOffInput.addEventListener('change', () => {
        stageKmlDraft(item.id, { enabled: onOffInput.checked });
      });

      const actions = document.createElement('div');
      actions.className = 'settings-kml-actions';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        if (!window.confirm(`Delete “${item.name}”?`)) return;
        try {
          kmlDrafts.delete(Number(item.id));
          await kmlController.removeOverlay(item.id);
        } catch (_) {
          /* alert already shown */
        }
      });

      actions.appendChild(delBtn);
      top.appendChild(nameInput);
      top.appendChild(onOff);
      top.appendChild(actions);

      const controls = document.createElement('div');
      controls.className = 'settings-kml-controls';

      const opacityLabel = document.createElement('label');
      opacityLabel.textContent = 'Opacity';
      opacityLabel.setAttribute('for', `settingsKmlOpacity_${item.id}`);
      const opacityRow = document.createElement('div');
      opacityRow.className = 'settings-kml-opacity-row';
      const opacityInput = document.createElement('input');
      opacityInput.type = 'range';
      opacityInput.id = `settingsKmlOpacity_${item.id}`;
      opacityInput.min = '0';
      opacityInput.max = '1';
      opacityInput.step = '0.05';
      opacityInput.value = String(item.opacity ?? 0.65);
      const opacityVal = document.createElement('span');
      opacityVal.className = 'settings-kml-opacity-val';
      opacityVal.textContent = `${Math.round((item.opacity ?? 0.65) * 100)}%`;
      opacityInput.addEventListener('input', () => {
        opacityVal.textContent = `${Math.round(parseFloat(opacityInput.value) * 100)}%`;
        stageKmlDraft(item.id, { opacity: parseFloat(opacityInput.value) });
      });
      opacityRow.appendChild(opacityInput);
      opacityRow.appendChild(opacityVal);

      controls.appendChild(opacityLabel);
      controls.appendChild(opacityRow);

      card.appendChild(top);
      card.appendChild(controls);
      settingsKmlList.appendChild(card);
    });
  }

  async function refreshKmlSettings({ preserveDrafts = false } = {}) {
    if (!kmlController) return;
    if (!preserveDrafts) kmlDrafts.clear();
    try {
      await kmlController.refreshList();
    } catch (_) {
      /* ignore */
    }
    renderKmlSettings(kmlController.getItems());
  }

  const showUserSettings = async () => {
    const user = userRef();
    const identity = document.getElementById('settingsUserIdentity');
    const nameEl = document.getElementById('settingsUserName');
    const emailEl = document.getElementById('settingsUserEmail');
    if (identity && nameEl && emailEl) {
      const displayName = (user?.name || '').trim();
      const displayEmail = (user?.email || '').trim();
      if (displayName || displayEmail) {
        nameEl.textContent = displayName || displayEmail;
        if (displayName && displayEmail) {
          emailEl.textContent = displayEmail;
          emailEl.hidden = false;
        } else {
          emailEl.textContent = '';
          emailEl.hidden = true;
        }
        identity.hidden = false;
      } else {
        nameEl.textContent = '';
        emailEl.textContent = '';
        identity.hidden = true;
      }
    }
    document.body.classList.add('settings-modal-open');
    document.getElementById('userSettingsModal').style.display = 'flex';
    const setBase = document.getElementById('settingsBase');
    Array.from(setBase.options).forEach(opt => {
      opt.style.display = (opt.value && !allowedBases.includes(opt.value)) ? 'none' : '';
    });
    setBase.value = user.default_base || baseSelect.value || '';
    renderOverlayOptions(setBase.value);
    const densitySection = document.getElementById('settingsDensitySection');
    if (densitySection) densitySection.style.display = allowedOver.includes('density') ? '' : 'none';

    if (user.default_lat != null) document.getElementById('settingsLat').value = user.default_lat;
    if (user.default_lon != null) document.getElementById('settingsLon').value = user.default_lon;
    if (user.default_zoom != null) document.getElementById('settingsZoom').value = user.default_zoom;

    const defaultOverlays = user.default_overlays || [];
    getVisibleOverlayDefs(setBase.value).forEach((overlayDef) => {
      const input = document.getElementById(overlayDef.inputId);
      if (input) {
        input.checked = defaultOverlays.includes(overlayDef.key);
      }
    });
    document.getElementById('settingsRulerUnit').value = user.default_units || 'm';
    document.getElementById('settingsSystem').value = user.default_system === 'UAS' ? 'UAS' : 'UAS';
    document.getElementById('settingsQuality').value = user.default_quality === 'HD' ? 'HD' : 'SD';

    const savedOpacity = user.density_opacity !== undefined ? user.density_opacity : 0.65;
    document.getElementById('settingsDensityOpacity').value = savedOpacity;
    document.getElementById('densityOpacityValue').textContent = Math.round(savedOpacity * 100) + '%';

    const borderColor = user.density_border_color || 'rgba(255,255,255,0.2)';
    const hoverColor = user.density_border_hover_color || 'rgba(0,0,0,0.9)';
    const borderMatch = borderColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (borderMatch) {
      const hex = '#' + [borderMatch[1], borderMatch[2], borderMatch[3]].map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
      document.getElementById('settingsDensityBorderColor').value = hex;
      document.getElementById('settingsDensityBorderOpacity').value = borderMatch[4] || 1;
      document.getElementById('borderOpacityValue').textContent = Math.round((borderMatch[4] || 1) * 100) + '%';
    }
    const hoverMatch = hoverColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (hoverMatch) {
      const hex = '#' + [hoverMatch[1], hoverMatch[2], hoverMatch[3]].map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
      document.getElementById('settingsDensityHoverColor').value = hex;
      document.getElementById('settingsDensityHoverOpacity').value = hoverMatch[4] || 1;
      document.getElementById('hoverOpacityValue').textContent = Math.round((hoverMatch[4] || 1) * 100) + '%';
    }

    document.getElementById('exportAttribution').checked = localStorage.getItem('scepmaps_export_attribution') !== 'false';
    const redOutlineCb = document.getElementById('settingsKmlRedOutline');
    if (redOutlineCb) redOutlineCb.checked = !!kmlController?.getRedOutline?.();
    const showNamesCb = document.getElementById('settingsKmlShowNames');
    if (showNamesCb) showNamesCb.checked = !!kmlController?.getShowNames?.();
    await refreshKmlSettings({ preserveDrafts: false });
    markSettingsClean();
  };

  const closeSettingsModal = () => {
    kmlDrafts.clear();
    document.body.classList.remove('settings-modal-open');
    document.getElementById('userSettingsModal').style.display = 'none';
    saveBtn.style.display = 'none';
  };

  const savePreferences = async () => {
    const lat = document.getElementById('settingsLat').value;
    const lon = document.getElementById('settingsLon').value;
    const zoom = document.getElementById('settingsZoom').value;
    const base = document.getElementById('settingsBase').value;
    const system = document.getElementById('settingsSystem').value;
    const quality = document.getElementById('settingsQuality').value;
    const units = document.getElementById('settingsRulerUnit').value;
    const densityOpacityVal = document.getElementById('settingsDensityOpacity').value;
    const borderHex = document.getElementById('settingsDensityBorderColor').value;
    const borderOpacity = parseFloat(document.getElementById('settingsDensityBorderOpacity').value);
    const hoverHex = document.getElementById('settingsDensityHoverColor').value;
    const hoverOpacity = parseFloat(document.getElementById('settingsDensityHoverOpacity').value);

    const preferences = {};
    if (lat !== '') preferences.default_lat = parseFloat(lat);
    if (lon !== '') preferences.default_lon = parseFloat(lon);
    if (zoom !== '') preferences.default_zoom = parseInt(zoom);
    if (base !== '') preferences.default_base = base;
    if (system !== '') preferences.default_system = system;
    if (quality !== '') preferences.default_quality = quality;
    if (units !== '') preferences.default_units = units;
    if (allowedOver.includes('density')) {
      preferences.density_opacity = parseFloat(densityOpacityVal);
      preferences.density_border_color = hexToRgba(borderHex, borderOpacity);
      preferences.density_border_hover_color = hexToRgba(hoverHex, hoverOpacity);
    }
    const overlays = [];
    getVisibleOverlayDefs(base).forEach((overlayDef) => {
      const input = document.getElementById(overlayDef.inputId);
      if (!input) return;
      if (input.checked) overlays.push(overlayDef.key);
    });
    preferences.default_overlays = overlays;

    try {
      await applyKmlDrafts();

      const res = await fetch(`${API_BASE}/auth/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getToken() },
        body: JSON.stringify(preferences)
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to save preferences');
      }
      const data = await res.json();
      setUser(data.user);
      localStorage.setItem('user', JSON.stringify(data.user));
      localStorage.setItem('scepmaps_export_attribution', document.getElementById('exportAttribution').checked.toString());
      if (units) {
        setRulerUnits(units);
        if (hasRulerPoints()) updateRulerLabels();
      }
      if (densityOpacityVal) updateDensityOpacity(parseFloat(densityOpacityVal));
      await refreshKmlSettings({ preserveDrafts: false });
      const message = document.getElementById('preferencesMessage');
      message.style.display = 'inline';
      setTimeout(() => { message.style.display = 'none'; }, 3000);
      markSettingsClean();
    } catch (error) {
      alert('Error saving preferences: ' + error.message);
    }
  };

  const setCurrentPosition = () => {
    const center = map.getCenter();
    const zoom = map.getZoom();
    document.getElementById('settingsLat').value = center.lat.toFixed(6);
    document.getElementById('settingsLon').value = center.lng.toFixed(6);
    document.getElementById('settingsZoom').value = zoom;
    refreshSaveButtonVisibility();
  };
  const useCurrentLayers = () => {
    document.getElementById('settingsBase').value = baseSelect.value;
    renderOverlayOptions(baseSelect.value);
    getVisibleOverlayDefs(baseSelect.value).forEach((overlayDef) => {
      const input = document.getElementById(overlayDef.inputId);
      if (input) input.checked = overlayDef.getChecked();
    });
    // Ensure hidden names option never lingers as selected in the snapshot state.
    if (!isNamesOverlayAvailableForBase(baseSelect.value)) {
      const namesInput = document.getElementById('settingsOverlayLabel');
      if (namesInput) namesInput.checked = false;
    }
    refreshSaveButtonVisibility();
  };
  function init() {
    bindIfExists('settingsDensityOpacity', 'input', (e) => {
      const opacity = parseFloat(e.target.value);
      document.getElementById('densityOpacityValue').textContent = Math.round(opacity * 100) + '%';
      updateDensityOpacity(opacity);
      refreshSaveButtonVisibility();
    });
    bindIfExists('settingsDensityBorderColor', 'input', updateBorderColorsFromInputs);
    bindIfExists('settingsDensityBorderOpacity', 'input', (e) => {
      document.getElementById('borderOpacityValue').textContent = Math.round(parseFloat(e.target.value) * 100) + '%';
      updateBorderColorsFromInputs();
      refreshSaveButtonVisibility();
    });
    bindIfExists('settingsDensityHoverColor', 'input', updateBorderColorsFromInputs);
    bindIfExists('settingsDensityHoverOpacity', 'input', (e) => {
      document.getElementById('hoverOpacityValue').textContent = Math.round(parseFloat(e.target.value) * 100) + '%';
      updateBorderColorsFromInputs();
      refreshSaveButtonVisibility();
    });
    settingsBody.addEventListener('input', refreshSaveButtonVisibility);
    settingsBody.addEventListener('change', refreshSaveButtonVisibility);
    document.getElementById('userSettingsModal').addEventListener('click', (e) => {
      if (e.target.id === 'userSettingsModal') closeSettingsModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (document.getElementById('userSettingsModal').style.display === 'flex') {
        closeSettingsModal();
      }
    });
    bindIfExists('settingsBtn', 'click', showUserSettings);
    bindIfExists('closeSettingsBtn', 'click', closeSettingsModal);
    bindIfExists('savePreferencesBtn', 'click', savePreferences);
    bindIfExists('setCurrentPositionBtn', 'click', setCurrentPosition);
    bindIfExists('useCurrentLayersBtn', 'click', useCurrentLayers);
    bindIfExists('settingsBase', 'change', (e) => {
      const selectedBase = e.target.value;
      renderOverlayOptions(selectedBase);
      refreshSaveButtonVisibility();
    });
    bindIfExists('settingsKmlImportBtn', 'click', async () => {
      if (!kmlController?.pickFile) return;
      kmlController.pickFile();
    });
    bindIfExists('settingsKmlRedOutline', 'change', (e) => {
      if (!kmlController?.setRedOutline) return;
      kmlController.setRedOutline(!!e.target.checked);
    });
    bindIfExists('settingsKmlShowNames', 'change', (e) => {
      if (!kmlController?.setShowNames) return;
      kmlController.setShowNames(!!e.target.checked);
    });
    if (kmlController?.onChange) {
      kmlController.onChange(() => {
        if (document.getElementById('userSettingsModal')?.style.display === 'flex') {
          collectKmlDraftsFromDom();
          renderKmlSettings(kmlController.getItems());
          refreshSaveButtonVisibility();
        }
      });
    }
  }

  return { init };
}
