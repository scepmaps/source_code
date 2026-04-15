export function createToolbarController(opts) {
  const {
    baseSelect,
    seamarksCb,
    openaipCb,
    densityCb,
    historyToggle,
    allowedBases,
    allowedOver,
    applyNamesOverlayForBase,
    setAttrib,
    updateLabelButtonVisibility,
    getIsNamesOverlayEnabled,
    setIsNamesOverlayEnabled,
  } = opts;

  const favMapOptions = {
    osm: '🗺️ OpenStreetMap',
    esri: '🛰️ Satellite',
    navigation: '🧭 Navigation',
    night: '🌙 Night',
    topo: '⛰️ Topographic',
    ocean: '🌊 Nav Dark',
    shom: '⚓ Charts',
    ukho: '🇬🇧 UKHO Charts',
    gbsouth: '✈️ GB South'
  };
  const favMapEmojis = {
    osm: '🗺️', esri: '🛰️', navigation: '🧭', night: '🌙',
    topo: '⛰️', ocean: '🌊', shom: '⚓', ukho: '🇬🇧', gbsouth: '✈️'
  };
  const favOverlayOptions = {
    seamarks: '⚓ Seamarks',
    openaip: '✈️ Airspace',
    label: '🏷️ Names',
    density: '🏘️ Density',
    history: '🕐 History'
  };
  const favOverlayEmojis = {
    seamarks: '⚓', openaip: '✈️', label: '🏷️', density: '🏘️', history: '🕐'
  };
  const favMapBtnIds = {
    osm: 'btnOsm', esri: 'btnEsri', navigation: 'btnNavigation',
    night: 'btnNight', topo: 'btnTopo', ocean: 'btnOcean',
    shom: 'btnShom', ukho: 'btnUkho', gbsouth: 'btnGbsouth'
  };
  const favOverlayBtnIds = {
    seamarks: 'btnSeamarks', openaip: 'btnOpenaip',
    label: 'btnLabel', density: 'btnDensity', history: 'btnHistory'
  };

  function updateMoreButtonsHighlight() {
    const moreMapsBtn = document.getElementById('btnMoreMaps');
    const moreOverlaysBtn = document.getElementById('btnMoreOverlays');
    const mapDropdown = document.getElementById('moreMapDropdown');
    const overlayDropdown = document.getElementById('moreOverlayDropdown');
    const isHidden = (el) => !!el && getComputedStyle(el).display === 'none';

    const activeBase = baseSelect?.value;
    const activeBaseBtn = activeBase ? document.getElementById(`btn${activeBase.charAt(0).toUpperCase()}${activeBase.slice(1)}`) : null;
    const mapInCollapsed = !!activeBaseBtn && isHidden(activeBaseBtn) && !(mapDropdown?.classList.contains('open'));
    moreMapsBtn?.classList.toggle('more-selected-collapsed', mapInCollapsed);

    const overlayStates = [
      { id: 'btnSeamarks', active: !!seamarksCb?.checked },
      { id: 'btnOpenaip', active: !!openaipCb?.checked },
      { id: 'btnDensity', active: !!densityCb?.checked },
      { id: 'btnHistory', active: !!historyToggle?.checked },
      { id: 'btnLabel', active: !!getIsNamesOverlayEnabled() },
    ];
    const activeHiddenOverlay = overlayStates.some(({ id, active }) => {
      if (!active) return false;
      const btn = document.getElementById(id);
      return isHidden(btn);
    });
    const overlayInCollapsed = activeHiddenOverlay && !(overlayDropdown?.classList.contains('open'));
    moreOverlaysBtn?.classList.toggle('more-selected-collapsed', overlayInCollapsed);
  }

  function updateBaseButtonStates() {
    const activeBase = baseSelect.value;
    document.querySelectorAll('[data-base]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.base === activeBase);
    });
    document.getElementById('btnLabel')?.classList.toggle('active', getIsNamesOverlayEnabled());
    updateMoreButtonsHighlight();
  }

  function updateOverlayButtonStates() {
    document.getElementById('btnSeamarks')?.classList.toggle('active', seamarksCb.checked);
    document.getElementById('btnOpenaip')?.classList.toggle('active', openaipCb.checked);
    document.getElementById('btnDensity')?.classList.toggle('active', densityCb.checked);
    document.getElementById('btnHistory')?.classList.toggle('active', historyToggle.checked);
    document.getElementById('btnLabel')?.classList.toggle('active', getIsNamesOverlayEnabled());
    updateMoreButtonsHighlight();
  }

  function setupEmojiButtons() {
    const baseButtons = {
      btnOsm: 'osm', btnEsri: 'esri', btnNavigation: 'navigation', btnNight: 'night',
      btnTopo: 'topo', btnOcean: 'ocean', btnShom: 'shom', btnUkho: 'ukho', btnGbsouth: 'gbsouth'
    };
    Object.keys(baseButtons).forEach(btnId => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        baseSelect.value = baseButtons[btnId];
        baseSelect.dispatchEvent(new Event('change'));
        updateBaseButtonStates();
        updateLabelButtonVisibility();
      });
    });

    document.getElementById('btnSeamarks')?.addEventListener('click', () => {
      seamarksCb.checked = !seamarksCb.checked;
      seamarksCb.dispatchEvent(new Event('change'));
      updateOverlayButtonStates();
    });
    document.getElementById('btnOpenaip')?.addEventListener('click', () => {
      openaipCb.checked = !openaipCb.checked;
      openaipCb.dispatchEvent(new Event('change'));
      updateOverlayButtonStates();
    });
    document.getElementById('btnHistory')?.addEventListener('click', () => {
      historyToggle.checked = !historyToggle.checked;
      historyToggle.dispatchEvent(new Event('change'));
      updateOverlayButtonStates();
    });
    document.getElementById('btnDensity')?.addEventListener('click', () => {
      densityCb.checked = !densityCb.checked;
      densityCb.dispatchEvent(new Event('change'));
      updateOverlayButtonStates();
    });
    document.getElementById('btnLabel')?.addEventListener('click', () => {
      setIsNamesOverlayEnabled(!getIsNamesOverlayEnabled());
      applyNamesOverlayForBase(baseSelect.value);
      setAttrib();
      updateOverlayButtonStates();
    });

    updateBaseButtonStates();
    updateOverlayButtonStates();
    updateLabelButtonVisibility();
  }

  function populateFavoriteSelects() {
    for (let i = 1; i <= 4; i++) {
      const select = document.getElementById(`favMap${i}`);
      select.innerHTML = '<option value="">-- None --</option>';
      allowedBases.forEach(base => {
        if (!favMapOptions[base]) return;
        const opt = document.createElement('option');
        opt.value = base;
        opt.textContent = favMapOptions[base];
        select.appendChild(opt);
      });
    }
    for (let i = 1; i <= 4; i++) {
      const select = document.getElementById(`favOverlay${i}`);
      select.innerHTML = '<option value="">-- None --</option>';
      allowedOver.forEach(overlay => {
        if (!favOverlayOptions[overlay]) return;
        const opt = document.createElement('option');
        opt.value = overlay;
        opt.textContent = favOverlayOptions[overlay];
        select.appendChild(opt);
      });
    }
  }

  function loadFavorites() {
    const saved = JSON.parse(localStorage.getItem('scepmaps_favorites') || '{}');
    for (let i = 1; i <= 4; i++) {
      const mapSel = document.getElementById(`favMap${i}`);
      if (saved.maps && saved.maps[i - 1]) mapSel.value = saved.maps[i - 1];
      const overSel = document.getElementById(`favOverlay${i}`);
      if (saved.overlays && saved.overlays[i - 1]) overSel.value = saved.overlays[i - 1];
    }
  }

  function saveFavorites() {
    const maps = [];
    const overlays = [];
    for (let i = 1; i <= 4; i++) {
      maps.push(document.getElementById(`favMap${i}`).value);
      overlays.push(document.getElementById(`favOverlay${i}`).value);
    }
    localStorage.setItem('scepmaps_favorites', JSON.stringify({ maps, overlays }));
  }

  function getSavedFavoriteKeys(kind, allowed, idMap) {
    const saved = JSON.parse(localStorage.getItem('scepmaps_favorites') || '{}');
    const values = Array.isArray(saved[kind]) ? saved[kind] : [];
    const seen = new Set();
    const out = [];
    values.forEach((k) => {
      if (!k || seen.has(k)) return;
      if (allowed.includes(k) && document.getElementById(idMap[k])) {
        seen.add(k);
        out.push(k);
      }
    });
    return out;
  }

  function populateMoreDropdown(dropdownId, items, emojis, type) {
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    dropdown.innerHTML = '';
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'emoji-btn';
      btn.id = `more_${type}_${item}`;
      btn.textContent = emojis[item] || '?';
      btn.title = favMapOptions[item] || favOverlayOptions[item] || item;
      btn.dataset[type] = item;

      if (type === 'overlay') {
        const isActive = (item === 'seamarks' && seamarksCb?.checked) ||
          (item === 'openaip' && openaipCb?.checked) ||
          (item === 'label' && getIsNamesOverlayEnabled()) ||
          (item === 'density' && densityCb?.checked) ||
          (item === 'history' && historyToggle?.checked);
        if (isActive) btn.classList.add('active');
      } else if (type === 'base') {
        if (baseSelect?.value === item) btn.classList.add('active');
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (type === 'overlay') {
          btn.classList.toggle('active');
        } else {
          dropdown.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        }
        const originalBtnId = type === 'base' ? favMapBtnIds[item] : favOverlayBtnIds[item];
        const originalBtn = document.getElementById(originalBtnId);
        if (originalBtn) originalBtn.click();
        dropdown.classList.remove('open');
      });
      dropdown.appendChild(btn);
    });
  }

  function layoutToolbarGroup(groupId, moreBtnId, dropdownId, orderedKeys, favorites, idMap, emojis, type, compactMode = false) {
    const group = document.getElementById(groupId);
    const moreBtn = document.getElementById(moreBtnId);
    const moreWrapper = moreBtn?.closest('.more-btn-wrapper');
    if (!group || !moreWrapper) return;
    const keys = orderedKeys.filter(k => document.getElementById(idMap[k]));
    const favored = favorites.filter(k => keys.includes(k));
    const nonFav = keys.filter(k => !favored.includes(k));
    const priority = compactMode ? favored : [...favored, ...nonFav];
    const forcedOverflow = compactMode ? [...nonFav] : [];

    // Reorder visible button sequence to match favorites-first priority.
    // This ensures on-screen icon order reflects settings selection.
    priority.forEach((k) => {
      const btn = document.getElementById(idMap[k]);
      if (btn) group.appendChild(btn);
    });
    if (group.lastElementChild !== moreWrapper) group.appendChild(moreWrapper);
    moreWrapper.style.display = '';
    keys.forEach(k => {
      const btn = document.getElementById(idMap[k]);
      if (btn) btn.style.display = '';
    });

    const groupWidth = group.clientWidth || 0;
    const moreWidth = moreWrapper.getBoundingClientRect().width || 44;
    const gap = parseFloat(getComputedStyle(group).gap || '6') || 6;

    const runLayoutPass = (reserveMoreButtonSpace) => {
      const available = Math.max(0, groupWidth - (reserveMoreButtonSpace ? (moreWidth + gap) : 0));
      let used = 0;
      const overflow = [...forcedOverflow];

      priority.forEach(k => {
        const btn = document.getElementById(idMap[k]);
        if (!btn) return;
        const w = btn.getBoundingClientRect().width || 44;
        if ((used + w) <= available) {
          btn.style.display = '';
          used += w + gap;
        } else {
          btn.style.display = 'none';
          if (!overflow.includes(k)) overflow.push(k);
        }
      });

      keys.forEach((k) => {
        if (!priority.includes(k)) {
          const btn = document.getElementById(idMap[k]);
          if (btn) btn.style.display = 'none';
          if (!overflow.includes(k)) overflow.push(k);
        }
      });
      keys.forEach((k) => {
        const btn = document.getElementById(idMap[k]);
        if (!btn || getComputedStyle(btn).display === 'none') {
          if (!overflow.includes(k)) overflow.push(k);
        }
      });

      return overflow;
    };

    // First pass: do not reserve width for the more button.
    // If everything fits, hide "..." completely.
    let overflow = runLayoutPass(false);
    if (overflow.length === 0) {
      moreWrapper.style.display = 'none';
      document.getElementById(dropdownId)?.classList.remove('open');
      populateMoreDropdown(dropdownId, [], emojis, type);
      return;
    }

    // Second pass: overflow exists, reserve room for "..." and recompute.
    moreWrapper.style.display = '';
    overflow = runLayoutPass(true);
    populateMoreDropdown(dropdownId, overflow, emojis, type);
  }

  function applyToolbarOverflowLayout() {
    const mapKeys = allowedBases.filter(b => favMapBtnIds[b]);
    const overlayKeys = allowedOver.filter(o => favOverlayBtnIds[o]);
    const favoriteMaps = getSavedFavoriteKeys('maps', allowedBases, favMapBtnIds);
    const favoriteOverlays = getSavedFavoriteKeys('overlays', allowedOver, favOverlayBtnIds);
    const compactMode = window.matchMedia('(max-width: 640px)').matches;

    layoutToolbarGroup('mapBtnGroup', 'btnMoreMaps', 'moreMapDropdown', mapKeys, favoriteMaps, favMapBtnIds, favMapEmojis, 'base', compactMode);
    layoutToolbarGroup('overlayBtnGroup', 'btnMoreOverlays', 'moreOverlayDropdown', overlayKeys, favoriteOverlays, favOverlayBtnIds, favOverlayEmojis, 'overlay', compactMode);
    updateMoreButtonsHighlight();
  }

  function applyFavorites(saveFirst = false) {
    if (saveFirst) saveFavorites();
    applyToolbarOverflowLayout();
  }

  function init() {
    setupEmojiButtons();

    document.getElementById('btnMoreMaps')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('moreMapDropdown');
      const overlayDropdown = document.getElementById('moreOverlayDropdown');
      overlayDropdown?.classList.remove('open');
      dropdown?.classList.toggle('open');
      updateMoreButtonsHighlight();
    });
    document.getElementById('btnMoreOverlays')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('moreOverlayDropdown');
      const mapDropdown = document.getElementById('moreMapDropdown');
      mapDropdown?.classList.remove('open');
      dropdown?.classList.toggle('open');
      updateMoreButtonsHighlight();
    });
    document.addEventListener('click', () => {
      document.getElementById('moreMapDropdown')?.classList.remove('open');
      document.getElementById('moreOverlayDropdown')?.classList.remove('open');
      updateMoreButtonsHighlight();
    });

    populateFavoriteSelects();
    loadFavorites();
    setTimeout(() => applyFavorites(false), 0);

    let toolbarOverflowRaf = null;
    const scheduleToolbarOverflowLayout = () => {
      if (toolbarOverflowRaf) cancelAnimationFrame(toolbarOverflowRaf);
      toolbarOverflowRaf = requestAnimationFrame(() => {
        applyToolbarOverflowLayout();
        toolbarOverflowRaf = null;
      });
    };
    window.addEventListener('resize', scheduleToolbarOverflowLayout);
    const mapBtnGroupEl = document.getElementById('mapBtnGroup');
    const overlayBtnGroupEl = document.getElementById('overlayBtnGroup');
    if (mapBtnGroupEl) new ResizeObserver(scheduleToolbarOverflowLayout).observe(mapBtnGroupEl);
    if (overlayBtnGroupEl) new ResizeObserver(scheduleToolbarOverflowLayout).observe(overlayBtnGroupEl);

    const clearFavoritesBtn = document.getElementById('clearFavoritesBtn');
    clearFavoritesBtn?.addEventListener('click', () => {
      localStorage.removeItem('scepmaps_favorites');
      for (let i = 1; i <= 4; i++) {
        const mapSel = document.getElementById(`favMap${i}`);
        const overSel = document.getElementById(`favOverlay${i}`);
        if (!mapSel || !overSel) continue;
        mapSel.value = '';
        overSel.value = '';
        mapSel.dispatchEvent(new Event('change', { bubbles: true }));
        overSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      applyFavorites(false);
      const btn = clearFavoritesBtn;
      if (!btn) return;
      const originalText = btn.textContent;
      btn.textContent = '✓ Cleared!';
      setTimeout(() => { btn.textContent = originalText; }, 1500);
    });
  }

  return {
    init,
    updateBaseButtonStates,
    updateOverlayButtonStates,
    applyFavorites,
    populateFavoriteSelects,
    loadFavorites,
  };
}
