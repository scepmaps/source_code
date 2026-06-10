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
    populateFavoriteSelects,
    loadFavorites,
    applyFavorites,
  } = opts;
  const settingsModal = document.getElementById('userSettingsModal');
  const settingsBody = settingsModal.querySelector('.stats-modal-body');
  const saveBtn = document.getElementById('savePreferencesBtn');
  const settingsOverlaysList = document.getElementById('settingsOverlaysList');
  let initialSettingsSnapshot = '';

  function bindIfExists(elementId, eventName, handler) {
    const el = document.getElementById(elementId);
    if (el) el.addEventListener(eventName, handler);
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

  const showUserSettings = () => {
    const user = userRef();
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

    populateFavoriteSelects();
    loadFavorites();
    document.getElementById('exportAttribution').checked = localStorage.getItem('scepmaps_export_attribution') !== 'false';
    markSettingsClean();
  };

  const closeSettingsModal = () => {
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
      applyFavorites(true);
      localStorage.setItem('scepmaps_export_attribution', document.getElementById('exportAttribution').checked.toString());
      if (units) {
        setRulerUnits(units);
        if (hasRulerPoints()) updateRulerLabels();
      }
      if (densityOpacityVal) updateDensityOpacity(parseFloat(densityOpacityVal));
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
  }

  return { init };
}
