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
    setRulerUnits,
    updateRulerLabels,
    hasRulerPoints,
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
      if (el.closest('#settingsPasswordSection')) return;
      if (el.type === 'button' || el.type === 'submit' || el.type === 'reset') return;
      if (el.type === 'checkbox' || el.type === 'radio') {
        state.push(`${el.id}:${el.checked}`);
      } else {
        state.push(`${el.id}:${el.value}`);
      }
    });
    return state.join('|');
  }

  function isDirty() {
    return getSettingsSnapshot() !== initialSettingsSnapshot;
  }

  function refreshSaveButtonVisibility() {
    saveBtn.style.display = isDirty() ? '' : 'none';
  }

  function markSettingsClean() {
    initialSettingsSnapshot = getSettingsSnapshot();
    refreshSaveButtonVisibility();
  }

  function clearPasswordFields() {
    ['settingsCurrentPassword', 'settingsNewPassword', 'settingsConfirmPassword'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
  }

  function setPasswordMessage(text, kind) {
    const msg = document.getElementById('passwordChangeMessage');
    if (!msg) return;
    if (!text) {
      msg.hidden = true;
      msg.textContent = '';
      msg.className = 'settings-password-message';
      return;
    }
    msg.hidden = false;
    msg.textContent = text;
    msg.className = `settings-password-message ${kind === 'ok' ? 'is-ok' : 'is-err'}`;
  }

  async function changePassword() {
    const currentEl = document.getElementById('settingsCurrentPassword');
    const newEl = document.getElementById('settingsNewPassword');
    const confirmEl = document.getElementById('settingsConfirmPassword');
    const btn = document.getElementById('changePasswordBtn');
    if (!currentEl || !newEl || !confirmEl || !btn) return;

    const currentPassword = currentEl.value;
    const newPassword = newEl.value;
    const confirmPassword = confirmEl.value;
    setPasswordMessage('');

    if (!currentPassword || !newPassword) {
      setPasswordMessage('Enter your current and new password.', 'err');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordMessage('New password must be at least 6 characters.', 'err');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage('New passwords do not match.', 'err');
      return;
    }
    if (currentPassword === newPassword) {
      setPasswordMessage('New password must be different.', 'err');
      return;
    }

    btn.disabled = true;
    const previousLabel = btn.textContent;
    btn.textContent = 'Updating…';
    try {
      const res = await fetch(`${API_BASE}/auth/change-password`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + getToken(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
          confirm_password: confirmPassword,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPasswordMessage(data.error || 'Could not update password.', 'err');
        return;
      }
      clearPasswordFields();
      setPasswordMessage('Password updated.', 'ok');
      setTimeout(() => setPasswordMessage(''), 4000);
    } catch (_) {
      setPasswordMessage('Network error. Please try again.', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = previousLabel;
    }
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

  function setFeedbackStatus(text, kind) {
    const msg = document.getElementById('feedbackMessageStatus');
    if (!msg) return;
    if (!text) {
      msg.hidden = true;
      msg.textContent = '';
      msg.className = 'feedback-status';
      return;
    }
    msg.hidden = false;
    msg.textContent = text;
    msg.className = `feedback-status ${kind === 'ok' ? 'is-ok' : 'is-err'}`;
  }

  function resetFeedbackForm() {
    const ta = document.getElementById('feedbackMessage');
    if (ta) ta.value = '';
    document.querySelectorAll('#feedbackTopics input[type="checkbox"]').forEach((cb) => {
      cb.checked = false;
    });
    setFeedbackStatus('');
  }

  function openFeedbackModal() {
    const modal = document.getElementById('feedbackModal');
    if (!modal) return;
    resetFeedbackForm();
    modal.hidden = false;
    document.getElementById('feedbackMessage')?.focus();
  }

  function closeFeedbackModal() {
    const modal = document.getElementById('feedbackModal');
    if (!modal) return;
    modal.hidden = true;
    setFeedbackStatus('');
  }

  async function sendFeedback() {
    const ta = document.getElementById('feedbackMessage');
    const btn = document.getElementById('sendFeedbackBtn');
    if (!ta || !btn) return;
    const message = ta.value.trim();
    if (message.length < 3) {
      setFeedbackStatus('Please write a short message.', 'err');
      return;
    }
    const topics = [...document.querySelectorAll('#feedbackTopics input[type="checkbox"]:checked')]
      .map((el) => el.value);

    const previousLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    setFeedbackStatus('Sending…', 'ok');
    try {
      const res = await fetch(`${API_BASE}/auth/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ message, topics }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedbackStatus(data.error || 'Failed to send feedback.', 'err');
        return;
      }
      setFeedbackStatus(data.message || 'Thanks — feedback sent.', 'ok');
      setTimeout(() => closeFeedbackModal(), 1200);
    } catch (_) {
      setFeedbackStatus('Network error. Please try again.', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = previousLabel;
    }
  }

  const closeSettingsModal = ({ force = false } = {}) => {
    if (!force && isDirty()) {
      if (!window.confirm('Discard unsaved changes?')) return false;
    }
    closeFeedbackModal();
    clearPasswordFields();
    setPasswordMessage('');
    document.body.classList.remove('settings-modal-open');
    document.getElementById('userSettingsModal').style.display = 'none';
    saveBtn.style.display = 'none';
    return true;
  };

  const showUserSettings = async () => {
    clearPasswordFields();
    setPasswordMessage('');
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
    Array.from(setBase.options).forEach((opt) => {
      opt.style.display = (opt.value && !allowedBases.includes(opt.value)) ? 'none' : '';
    });
    setBase.value = user.default_base || baseSelect.value || '';
    renderOverlayOptions(setBase.value);

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
    const systemEl = document.getElementById('settingsSystem');
    const qualityEl = document.getElementById('settingsQuality');
    if (systemEl) systemEl.value = user.default_system === 'UAS' ? 'UAS' : 'UAS';
    if (qualityEl) qualityEl.value = user.default_quality === 'HD' ? 'HD' : 'SD';

    const attributionEl = document.getElementById('exportAttribution');
    if (attributionEl) {
      attributionEl.checked = localStorage.getItem('scepmaps_export_attribution') !== 'false';
    }
    markSettingsClean();
  };

  const savePreferences = async () => {
    const lat = document.getElementById('settingsLat').value;
    const lon = document.getElementById('settingsLon').value;
    const zoom = document.getElementById('settingsZoom').value;
    const base = document.getElementById('settingsBase').value;
    const system = document.getElementById('settingsSystem')?.value;
    const quality = document.getElementById('settingsQuality')?.value;
    const units = document.getElementById('settingsRulerUnit').value;

    const preferences = {};
    if (lat !== '') preferences.default_lat = parseFloat(lat);
    if (lon !== '') preferences.default_lon = parseFloat(lon);
    if (zoom !== '') preferences.default_zoom = parseInt(zoom, 10);
    if (base !== '') preferences.default_base = base;
    if (system) preferences.default_system = system;
    if (quality) preferences.default_quality = quality;
    if (units !== '') preferences.default_units = units;
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
        body: JSON.stringify(preferences),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to save preferences');
      }
      const data = await res.json();
      setUser(data.user);
      localStorage.setItem('user', JSON.stringify(data.user));
      const attributionEl = document.getElementById('exportAttribution');
      if (attributionEl) {
        localStorage.setItem('scepmaps_export_attribution', attributionEl.checked.toString());
      }
      if (units) {
        setRulerUnits(units);
        if (hasRulerPoints()) updateRulerLabels();
      }
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
    if (!isNamesOverlayAvailableForBase(baseSelect.value)) {
      const namesInput = document.getElementById('settingsOverlayLabel');
      if (namesInput) namesInput.checked = false;
    }
    refreshSaveButtonVisibility();
  };

  function init() {
    settingsBody.addEventListener('input', refreshSaveButtonVisibility);
    settingsBody.addEventListener('change', refreshSaveButtonVisibility);
    document.getElementById('userSettingsModal').addEventListener('click', (e) => {
      if (e.target.id === 'userSettingsModal') closeSettingsModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const feedbackModal = document.getElementById('feedbackModal');
      if (feedbackModal && !feedbackModal.hidden) {
        closeFeedbackModal();
        return;
      }
      if (document.getElementById('userSettingsModal').style.display === 'flex') {
        closeSettingsModal();
      }
    });
    bindIfExists('settingsBtn', 'click', showUserSettings);
    bindIfExists('closeSettingsBtn', 'click', () => closeSettingsModal());
    bindIfExists('savePreferencesBtn', 'click', savePreferences);
    bindIfExists('changePasswordBtn', 'click', changePassword);
    bindIfExists('settingsFeedbackBtn', 'click', openFeedbackModal);
    bindIfExists('closeFeedbackBtn', 'click', closeFeedbackModal);
    bindIfExists('cancelFeedbackBtn', 'click', closeFeedbackModal);
    bindIfExists('sendFeedbackBtn', 'click', sendFeedback);
    document.getElementById('feedbackModal')?.addEventListener('click', (e) => {
      if (e.target?.id === 'feedbackModal') closeFeedbackModal();
    });
    bindIfExists('setCurrentPositionBtn', 'click', setCurrentPosition);
    bindIfExists('useCurrentLayersBtn', 'click', useCurrentLayers);
    bindIfExists('settingsBase', 'change', (e) => {
      renderOverlayOptions(e.target.value);
      refreshSaveButtonVisibility();
    });
  }

  return { init, closeSettingsModal, showUserSettings };
}
