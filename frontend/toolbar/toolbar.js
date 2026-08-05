import { iconHtml } from './icons.js';
import { TOOL_BTN_IDS, TOOL_LABELS, TOOL_ICONS } from '../tools/tools.js';

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
    osm: 'OpenStreetMap',
    esri: 'Satellite',
    navigation: 'Navigation',
    night: 'Night',
    topo: 'Topographic',
    ocean: 'Nav Dark',
    shom: 'Charts',
    ukho: 'UKHO Charts',
    gbsouth: 'GB South'
  };
  const favMapIcons = {
    osm: iconHtml('osm'),
    esri: iconHtml('esri'),
    navigation: iconHtml('navigation'),
    night: iconHtml('night'),
    topo: iconHtml('topo'),
    ocean: iconHtml('ocean'),
    shom: iconHtml('shom'),
    ukho: iconHtml('ukho'),
    gbsouth: iconHtml('gbsouth'),
  };
  const favOverlayOptions = {
    seamarks: 'Seamarks',
    openaip: 'Airspace',
    label: 'Names',
    density: 'Density',
    history: 'History'
  };
  const favOverlayIcons = {
    seamarks: iconHtml('seamarks'),
    openaip: iconHtml('openaip'),
    label: iconHtml('label'),
    density: iconHtml('density'),
    history: iconHtml('history'),
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
  const toolBtnIds = { ...TOOL_BTN_IDS };
  const toolOptions = { ...TOOL_LABELS };
  const toolIcons = { ...TOOL_ICONS };

  function closeAllMoreDropdowns(exceptId = null) {
    ['moreMapDropdown', 'moreOverlayDropdown', 'moreToolDropdown'].forEach((id) => {
      if (id === exceptId) return;
      document.getElementById(id)?.classList.remove('open');
    });
  }

  function isToolButtonActive(btn) {
    if (!btn) return false;
    // primary is the idle draw state for the box tool — not an "in use" signal
    return btn.classList.contains('map-tool-btn--active')
      || btn.classList.contains('map-tool-btn--danger')
      || btn.classList.contains('map-tool-btn--armed');
  }

  function updateMoreButtonsHighlight() {
    const moreMapsBtn = document.getElementById('btnMoreMaps');
    const moreOverlaysBtn = document.getElementById('btnMoreOverlays');
    const moreToolsBtn = document.getElementById('btnMoreTools');
    const mapDropdown = document.getElementById('moreMapDropdown');
    const overlayDropdown = document.getElementById('moreOverlayDropdown');
    const toolDropdown = document.getElementById('moreToolDropdown');
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

    const activeHiddenTool = Object.values(toolBtnIds).some((id) => {
      const btn = document.getElementById(id);
      return !!btn && isHidden(btn) && isToolButtonActive(btn);
    });
    const toolsInCollapsed = activeHiddenTool && !(toolDropdown?.classList.contains('open'));
    moreToolsBtn?.classList.toggle('more-selected-collapsed', toolsInCollapsed);
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

  function populateMoreDropdown(dropdownId, items, iconMap, type) {
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    dropdown.innerHTML = '';
    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'emoji-btn';
      btn.id = `more_${type}_${item}`;
      btn.innerHTML = iconMap[item] || '?';
      btn.title = favMapOptions[item] || favOverlayOptions[item] || toolOptions[item] || item;
      btn.dataset[type] = item;

      const originalBtnId = type === 'base'
        ? favMapBtnIds[item]
        : type === 'overlay'
          ? favOverlayBtnIds[item]
          : toolBtnIds[item];
      const originalBtn = document.getElementById(originalBtnId);

      if (type === 'overlay') {
        const isActive = (item === 'seamarks' && seamarksCb?.checked) ||
          (item === 'openaip' && openaipCb?.checked) ||
          (item === 'label' && getIsNamesOverlayEnabled()) ||
          (item === 'density' && densityCb?.checked) ||
          (item === 'history' && historyToggle?.checked);
        if (isActive) btn.classList.add('active');
      } else if (type === 'base') {
        if (baseSelect?.value === item) btn.classList.add('active');
      } else if (type === 'tool' && originalBtn) {
        ['map-tool-btn--active', 'map-tool-btn--primary', 'map-tool-btn--danger', 'map-tool-btn--armed'].forEach((cls) => {
          if (originalBtn.classList.contains(cls)) btn.classList.add(cls);
        });
        if (originalBtn.innerHTML) btn.innerHTML = originalBtn.innerHTML;
        btn.title = originalBtn.title || btn.title;
      }

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (type === 'overlay') {
          btn.classList.toggle('active');
        } else if (type === 'base') {
          dropdown.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
        }
        if (originalBtn) originalBtn.click();
        dropdown.classList.remove('open');
        updateMoreButtonsHighlight();
      });
      dropdown.appendChild(btn);
    });
  }

  function allocatePanelHeights(railH, gapCount, panels) {
    const usable = Math.max(0, railH - gapCount);
    const minSum = panels.reduce((sum, p) => sum + p.minH, 0);
    if (usable <= 0) {
      return Object.fromEntries(panels.map((p) => [p.key, p.minH]));
    }
    if (minSum >= usable) {
      // Scale all panels down so they fit the available rail height.
      const scale = usable / minSum;
      return Object.fromEntries(panels.map((p) => [p.key, Math.max(64, Math.floor(p.minH * scale))]));
    }
    const extra = usable - minSum;
    const weightSum = panels.reduce((sum, p) => sum + p.weight, 0) || 1;
    return Object.fromEntries(panels.map((p) => [
      p.key,
      p.minH + Math.floor(extra * (p.weight / weightSum)),
    ]));
  }

  function layoutToolbarGroup(groupId, moreBtnId, dropdownId, orderedKeys, favorites, idMap, iconMap, type, compactMode = false, heightBudget = 0) {
    const group = document.getElementById(groupId);
    const moreBtn = document.getElementById(moreBtnId);
    const moreWrapper = moreBtn?.closest('.more-btn-wrapper');
    if (!group || !moreWrapper) return;
    const keys = orderedKeys.filter(k => document.getElementById(idMap[k]));
    if (!keys.length) {
      moreWrapper.style.display = 'none';
      populateMoreDropdown(dropdownId, [], iconMap, type);
      return;
    }
    const favored = favorites.filter(k => keys.includes(k));
    const nonFav = keys.filter(k => !favored.includes(k));
    // Side rail: show favorites first; without favorites, show all until height limit.
    const priority = favored.length ? [...favored, ...nonFav] : [...keys];
    const forcedOverflow = compactMode && favored.length ? [...nonFav] : [];

    // Reorder visible button sequence to match favorites-first priority.
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

    const fallbackSlots = compactMode ? 2 : 4;
    const moreHeight = moreWrapper.getBoundingClientRect().height || 38;
    const gap = parseFloat(getComputedStyle(group).gap || '8') || 8;
    const groupHeightBudget = heightBudget > 0 ? heightBudget : fallbackSlots * (38 + gap);

    const runLayoutPass = (reserveMoreButtonSpace) => {
      const available = Math.max(0, groupHeightBudget - (reserveMoreButtonSpace ? (moreHeight + gap) : 0));
      let used = 0;
      const overflow = [...forcedOverflow];

      priority.forEach(k => {
        const btn = document.getElementById(idMap[k]);
        if (!btn) return;
        if (forcedOverflow.includes(k)) {
          btn.style.display = 'none';
          return;
        }
        const h = btn.getBoundingClientRect().height || 38;
        if ((used + h) <= available + 0.5) {
          btn.style.display = '';
          used += h + gap;
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

    // First pass: do not reserve height for the more button.
    let overflow = runLayoutPass(false);
    if (overflow.length === 0) {
      moreWrapper.style.display = 'none';
      document.getElementById(dropdownId)?.classList.remove('open');
      populateMoreDropdown(dropdownId, [], iconMap, type);
      return;
    }

    // Second pass: overflow exists, reserve room for "..." and recompute.
    moreWrapper.style.display = '';
    overflow = runLayoutPass(true);
    // Always keep at least the more button usable under extreme zoom.
    if (overflow.length === keys.length) {
      // Everything overflowed — still show more so options remain reachable.
      moreWrapper.style.display = '';
    }
    populateMoreDropdown(dropdownId, overflow, iconMap, type);
  }

  function applyToolbarOverflowLayout() {
    const mapKeys = allowedBases.filter(b => favMapBtnIds[b]);
    const overlayKeys = allowedOver.filter(o => favOverlayBtnIds[o]);
    const toolKeys = Object.keys(toolBtnIds).filter((k) => document.getElementById(toolBtnIds[k]));
    const favoriteMaps = getSavedFavoriteKeys('maps', allowedBases, favMapBtnIds);
    const favoriteOverlays = getSavedFavoriteKeys('overlays', allowedOver, favOverlayBtnIds);
    const compactMode = window.matchMedia('(max-height: 780px), (max-width: 640px)').matches;
    const tightMode = window.matchMedia('(max-height: 620px)').matches;

    const budgets = { maps: 0, overlays: 0, tools: 0 };
    const rail = document.getElementById('sideRail');
    if (rail) {
      const gap = parseFloat(getComputedStyle(rail).gap || '12') || 12;
      const railH = rail.clientHeight || 0;
      // Absolute mins: label + one icon slot + more button (+ padding)
      const floor = tightMode ? 72 : 88;
      const heights = allocatePanelHeights(railH, gap * 2, [
        { key: 'maps', weight: 2.2, minH: floor },
        { key: 'overlays', weight: 1.6, minH: floor },
        { key: 'tools', weight: 1.1, minH: floor },
      ]);

      rail.querySelectorAll('.side-oval').forEach((el) => {
        const panel = el.dataset.panel;
        const panelH = heights[panel] || floor;
        el.style.maxHeight = `${panelH}px`;
        el.style.height = 'auto';
        const labelEl = el.querySelector('.side-oval-label');
        const labelH = labelEl ? labelEl.getBoundingClientRect().height + 8 : 18;
        const pad = tightMode ? 18 : 28;
        budgets[panel] = Math.max(0, panelH - labelH - pad);
      });

      rail.classList.toggle('side-rail--compact', compactMode);
      rail.classList.toggle('side-rail--tight', tightMode);
    }

    layoutToolbarGroup('mapBtnGroup', 'btnMoreMaps', 'moreMapDropdown', mapKeys, favoriteMaps, favMapBtnIds, favMapIcons, 'base', compactMode, budgets.maps);
    layoutToolbarGroup('overlayBtnGroup', 'btnMoreOverlays', 'moreOverlayDropdown', overlayKeys, favoriteOverlays, favOverlayBtnIds, favOverlayIcons, 'overlay', compactMode, budgets.overlays);
    layoutToolbarGroup('toolBtnGroup', 'btnMoreTools', 'moreToolDropdown', toolKeys, [], toolBtnIds, toolIcons, 'tool', compactMode, budgets.tools);
    updateMoreButtonsHighlight();
  }

  function applyFavorites(saveFirst = false) {
    if (saveFirst) saveFavorites();
    applyToolbarOverflowLayout();
  }

  function init() {
    setupEmojiButtons();

    // Keep map interactions from stealing pointer events on the side rail.
    const sideRail = document.getElementById('sideRail');
    sideRail?.addEventListener('mousedown', (e) => e.stopPropagation());
    sideRail?.addEventListener('dblclick', (e) => e.stopPropagation());
    sideRail?.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    document.getElementById('btnMoreMaps')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('moreMapDropdown');
      const wasOpen = dropdown?.classList.contains('open');
      closeAllMoreDropdowns();
      if (!wasOpen) dropdown?.classList.add('open');
      updateMoreButtonsHighlight();
    });
    document.getElementById('btnMoreOverlays')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('moreOverlayDropdown');
      const wasOpen = dropdown?.classList.contains('open');
      closeAllMoreDropdowns();
      if (!wasOpen) dropdown?.classList.add('open');
      updateMoreButtonsHighlight();
    });
    document.getElementById('btnMoreTools')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('moreToolDropdown');
      const wasOpen = dropdown?.classList.contains('open');
      closeAllMoreDropdowns();
      if (!wasOpen) dropdown?.classList.add('open');
      updateMoreButtonsHighlight();
    });
    document.addEventListener('click', () => {
      closeAllMoreDropdowns();
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
    const sideRailEl = document.getElementById('sideRail');
    const mapBtnGroupEl = document.getElementById('mapBtnGroup');
    const overlayBtnGroupEl = document.getElementById('overlayBtnGroup');
    const toolBtnGroupEl = document.getElementById('toolBtnGroup');
    if (sideRailEl) new ResizeObserver(scheduleToolbarOverflowLayout).observe(sideRailEl);
    if (mapBtnGroupEl) new ResizeObserver(scheduleToolbarOverflowLayout).observe(mapBtnGroupEl);
    if (overlayBtnGroupEl) new ResizeObserver(scheduleToolbarOverflowLayout).observe(overlayBtnGroupEl);
    if (toolBtnGroupEl) new ResizeObserver(scheduleToolbarOverflowLayout).observe(toolBtnGroupEl);

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
    updateMoreButtonsHighlight,
    applyFavorites,
    applyToolbarOverflowLayout,
    populateFavoriteSelects,
    loadFavorites,
  };
}
