export function initSettingsController(opts) {
  const {
    userRef,
    setUser,
    token,
    API_BASE,
    allowedBases,
    allowedOver,
    map,
    baseSelect,
    seamarksCb,
    openaipCb,
    densityCb,
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
  let initialSettingsSnapshot = '';

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

  const showUserSettings = () => {
    const user = userRef();
    document.body.classList.add('settings-modal-open');
    document.getElementById('userSettingsModal').style.display = 'flex';
    const setBase = document.getElementById('settingsBase');
    Array.from(setBase.options).forEach(opt => {
      opt.style.display = (opt.value && !allowedBases.includes(opt.value)) ? 'none' : '';
    });
    document.getElementById('settingsSeamarks').closest('label').style.display = allowedOver.includes('seamarks') ? '' : 'none';
    document.getElementById('settingsOpenaip').closest('label').style.display = allowedOver.includes('openaip') ? '' : 'none';
    document.getElementById('settingsDensity').closest('label').style.display = allowedOver.includes('density') ? '' : 'none';
    const densitySection = document.getElementById('settingsDensitySection');
    if (densitySection) densitySection.style.display = allowedOver.includes('density') ? '' : 'none';

    if (user.default_lat != null) document.getElementById('settingsLat').value = user.default_lat;
    if (user.default_lon != null) document.getElementById('settingsLon').value = user.default_lon;
    if (user.default_zoom != null) document.getElementById('settingsZoom').value = user.default_zoom;
    setBase.value = user.default_base || '';

    const defaultOverlays = user.default_overlays || [];
    document.getElementById('settingsSeamarks').checked = defaultOverlays.includes('seamarks');
    document.getElementById('settingsOpenaip').checked = defaultOverlays.includes('openaip');
    document.getElementById('settingsDensity').checked = defaultOverlays.includes('density');
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
    if (document.getElementById('settingsSeamarks').checked) overlays.push('seamarks');
    if (document.getElementById('settingsOpenaip').checked) overlays.push('openaip');
    if (allowedOver.includes('density') && document.getElementById('settingsDensity').checked) overlays.push('density');
    preferences.default_overlays = overlays;

    try {
      const res = await fetch(`${API_BASE}/auth/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
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
  const clearPosition = () => {
    document.getElementById('settingsLat').value = '';
    document.getElementById('settingsLon').value = '';
    document.getElementById('settingsZoom').value = '';
    refreshSaveButtonVisibility();
  };
  const useCurrentLayers = () => {
    document.getElementById('settingsBase').value = baseSelect.value;
    document.getElementById('settingsSeamarks').checked = seamarksCb.checked;
    document.getElementById('settingsOpenaip').checked = openaipCb.checked;
    document.getElementById('settingsDensity').checked = densityCb.checked;
    refreshSaveButtonVisibility();
  };
  function init() {
    document.getElementById('settingsDensityOpacity').addEventListener('input', (e) => {
      const opacity = parseFloat(e.target.value);
      document.getElementById('densityOpacityValue').textContent = Math.round(opacity * 100) + '%';
      updateDensityOpacity(opacity);
      refreshSaveButtonVisibility();
    });
    document.getElementById('settingsDensityBorderColor').addEventListener('input', updateBorderColorsFromInputs);
    document.getElementById('settingsDensityBorderOpacity').addEventListener('input', (e) => {
      document.getElementById('borderOpacityValue').textContent = Math.round(parseFloat(e.target.value) * 100) + '%';
      updateBorderColorsFromInputs();
      refreshSaveButtonVisibility();
    });
    document.getElementById('settingsDensityHoverColor').addEventListener('input', updateBorderColorsFromInputs);
    document.getElementById('settingsDensityHoverOpacity').addEventListener('input', (e) => {
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
    document.getElementById('settingsBtn').addEventListener('click', showUserSettings);
    document.getElementById('closeSettingsBtn').addEventListener('click', closeSettingsModal);
    document.getElementById('savePreferencesBtn').addEventListener('click', savePreferences);
    document.getElementById('setCurrentPositionBtn').addEventListener('click', setCurrentPosition);
    document.getElementById('clearPositionBtn').addEventListener('click', clearPosition);
    document.getElementById('useCurrentLayersBtn').addEventListener('click', useCurrentLayers);
  }

  return { init };
}
