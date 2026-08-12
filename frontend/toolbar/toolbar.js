import { iconHtml } from './icons.js?v=20260807o';
import { TOOL_BTN_IDS, TOOL_LABELS, TOOL_ICONS } from '../tools/tools.js?v=20260812c';

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
    onMapsPickerOpen,
  } = opts;

  const favMapOptions = {
    osm: 'OpenStreetMap',
    dark: 'OSM Dark',
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
    dark: iconHtml('dark'),
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
    label: 'Name Tags',
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
    osm: 'btnOsm', dark: 'btnDark', esri: 'btnEsri', navigation: 'btnNavigation',
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

  function isMobileApp() {
    return document.body.classList.contains('mobile-app');
  }

  function setMobileSheetOpen(open) {
    if (!isMobileApp()) return;
    document.body.classList.toggle('mobile-sheet-open', !!open);
    const backdrop = document.getElementById('mobileSheetBackdrop');
    if (backdrop) backdrop.hidden = !open;
  }

  function closeAllPanels(exceptId = null) {
    // Draw panel is sticky — only closed via its own button toggle or Esc.
    ['mapPickerPanel', 'overlayPickerPanel', 'moreToolDropdown', 'kmlPickerPanel'].forEach((id) => {
      if (id === exceptId) return;
      const el = document.getElementById(id);
      el?.classList.remove('open');
      if (el) {
        el.classList.remove('has-more-open');
        el.style.top = '';
        el.style.bottom = '';
        el.style.left = '';
        el.style.right = '';
        el.style.transform = '';
        const more = el.querySelector(':scope > .rail-panel-more');
        const side =
          el._moreSideEl ||
          el.querySelector(':scope > .rail-panel-more-side') ||
          el.parentElement?.querySelector(`.rail-panel-more-side[data-for="${el.id}"]`);
        const moreBtn = more?.querySelector('.rail-panel-more-btn');
        more?.classList.remove('is-expanded');
        if (side) {
          side.hidden = true;
          side.classList.remove('is-open');
        }
        if (moreBtn) {
          moreBtn.setAttribute('aria-expanded', 'false');
          moreBtn.textContent = 'More';
        }
      }
    });
    document.getElementById('btnMaps')?.setAttribute('aria-expanded', 'false');
    document.getElementById('btnOverlays')?.setAttribute('aria-expanded', 'false');
    document.getElementById('btnKml')?.setAttribute('aria-expanded', 'false');
    document.getElementById('btnMaps')?.classList.remove('panel-open');
    document.getElementById('btnOverlays')?.classList.remove('panel-open');
    document.getElementById('btnKml')?.classList.remove('panel-open', 'map-tool-btn--active');
    const anyOpen = !!document.querySelector(
      '#mapPickerPanel.open, #overlayPickerPanel.open, #moreToolDropdown.open, #kmlPickerPanel.open, #drawPickerPanel.open'
    );
    setMobileSheetOpen(anyOpen);
  }

  function isToolButtonActive(btn) {
    if (!btn) return false;
    return btn.classList.contains('map-tool-btn--active')
      || btn.classList.contains('map-tool-btn--danger')
      || btn.classList.contains('map-tool-btn--armed');
  }

  function anyOverlayActive() {
    return !!(seamarksCb?.checked
      || openaipCb?.checked
      || densityCb?.checked
      || historyToggle?.checked
      || getIsNamesOverlayEnabled());
  }

  function updateSectionButtonStates() {
    const mapsBtn = document.getElementById('btnMaps');
    const overlaysBtn = document.getElementById('btnOverlays');
    const mapPanelOpen = document.getElementById('mapPickerPanel')?.classList.contains('open');
    const overlayPanelOpen = document.getElementById('overlayPickerPanel')?.classList.contains('open');

    mapsBtn?.classList.toggle('active', !!mapPanelOpen);
    mapsBtn?.classList.toggle('panel-open', !!mapPanelOpen);
    mapsBtn?.setAttribute('aria-expanded', mapPanelOpen ? 'true' : 'false');

    // Overlays icon stays lit when any overlay is on, or when the panel is open.
    overlaysBtn?.classList.toggle('active', !!overlayPanelOpen || anyOverlayActive());
    overlaysBtn?.classList.toggle('panel-open', !!overlayPanelOpen);
    overlaysBtn?.setAttribute('aria-expanded', overlayPanelOpen ? 'true' : 'false');
    overlaysBtn?.classList.toggle('has-active-items', anyOverlayActive());
  }

  function updateMoreButtonsHighlight() {
    const moreToolsBtn = document.getElementById('btnMoreTools');
    const toolDropdown = document.getElementById('moreToolDropdown');
    const isHidden = (el) => !!el && getComputedStyle(el).display === 'none';

    const activeHiddenTool = Object.values(toolBtnIds).some((id) => {
      const btn = document.getElementById(id);
      return !!btn && isHidden(btn) && isToolButtonActive(btn);
    });
    const toolsInCollapsed = activeHiddenTool && !(toolDropdown?.classList.contains('open'));
    moreToolsBtn?.classList.toggle('more-selected-collapsed', toolsInCollapsed);
    updateSectionButtonStates();
  }

  function updateBaseButtonStates() {
    const activeBase = baseSelect.value;
    document.querySelectorAll('[data-base]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.base === activeBase);
    });
    document.querySelectorAll('#mapPickerPanel .rail-panel-item').forEach((row) => {
      row.classList.toggle('active', row.dataset.base === activeBase);
    });
    document.getElementById('btnLabel')?.classList.toggle('active', getIsNamesOverlayEnabled());
    updateMoreButtonsHighlight();
  }

  function updateOverlayButtonStates() {
    document.getElementById('btnSeamarks')?.classList.toggle('active', !!seamarksCb?.checked);
    document.getElementById('btnOpenaip')?.classList.toggle('active', !!openaipCb?.checked);
    document.getElementById('btnDensity')?.classList.toggle('active', !!densityCb?.checked);
    document.getElementById('btnHistory')?.classList.toggle('active', !!historyToggle?.checked);
    document.getElementById('btnLabel')?.classList.toggle('active', !!getIsNamesOverlayEnabled());

    const states = {
      seamarks: !!seamarksCb?.checked,
      openaip: !!openaipCb?.checked,
      label: !!getIsNamesOverlayEnabled(),
      density: !!densityCb?.checked,
      history: !!historyToggle?.checked,
    };
    document.querySelectorAll('#overlayPickerPanel .rail-panel-item').forEach((row) => {
      const key = row.dataset.overlay;
      row.classList.toggle('active', !!states[key]);
    });
    updateMoreButtonsHighlight();
  }

  function toggleOverlayByKey(key) {
    if (key === 'seamarks' && seamarksCb) {
      seamarksCb.checked = !seamarksCb.checked;
      seamarksCb.dispatchEvent(new Event('change'));
    } else if (key === 'openaip' && openaipCb) {
      openaipCb.checked = !openaipCb.checked;
      openaipCb.dispatchEvent(new Event('change'));
    } else if (key === 'history' && historyToggle) {
      historyToggle.checked = !historyToggle.checked;
      historyToggle.dispatchEvent(new Event('change'));
    } else if (key === 'density' && densityCb) {
      densityCb.checked = !densityCb.checked;
      densityCb.dispatchEvent(new Event('change'));
    } else if (key === 'label') {
      setIsNamesOverlayEnabled(!getIsNamesOverlayEnabled());
      applyNamesOverlayForBase(baseSelect.value);
      setAttrib();
    }
    updateOverlayButtonStates();
  }

  function isOverlayButtonAvailable(key) {
    const btnId = favOverlayBtnIds[key];
    if (!btnId) return false;
    const btn = document.getElementById(btnId);
    if (!btn) return false;
    // Name Tags only apply on Satellite (and similar); keep the picker in sync.
    if (key === 'label' && btn.style.display === 'none') return false;
    return true;
  }

  function setupEmojiButtons() {
    const baseButtons = {
      btnOsm: 'osm', btnDark: 'dark', btnEsri: 'esri', btnNavigation: 'navigation', btnNight: 'night',
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
        refreshOverlayPicker();
      });
    });

    document.getElementById('btnSeamarks')?.addEventListener('click', () => toggleOverlayByKey('seamarks'));
    document.getElementById('btnOpenaip')?.addEventListener('click', () => toggleOverlayByKey('openaip'));
    document.getElementById('btnHistory')?.addEventListener('click', () => toggleOverlayByKey('history'));
    document.getElementById('btnDensity')?.addEventListener('click', () => toggleOverlayByKey('density'));
    document.getElementById('btnLabel')?.addEventListener('click', () => toggleOverlayByKey('label'));

    updateBaseButtonStates();
    updateOverlayButtonStates();
    updateLabelButtonVisibility();
  }

  function populateFavoriteSelects() {
    for (let i = 1; i <= 4; i++) {
      const select = document.getElementById(`favMap${i}`);
      if (!select) continue;
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
      if (!select) continue;
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
      if (mapSel && saved.maps && saved.maps[i - 1]) mapSel.value = saved.maps[i - 1];
      const overSel = document.getElementById(`favOverlay${i}`);
      if (overSel && saved.overlays && saved.overlays[i - 1]) overSel.value = saved.overlays[i - 1];
    }
  }

  function saveFavorites() {
    // Settings UI no longer exposes favorite selects — don't overwrite saved favorites with blanks.
    if (!document.getElementById('favMap1') && !document.getElementById('favOverlay1')) return;
    const maps = [];
    const overlays = [];
    for (let i = 1; i <= 4; i++) {
      const mapSel = document.getElementById(`favMap${i}`);
      const overSel = document.getElementById(`favOverlay${i}`);
      maps.push(mapSel ? mapSel.value : '');
      overlays.push(overSel ? overSel.value : '');
    }
    localStorage.setItem('scepmaps_favorites', JSON.stringify({ maps, overlays }));
  }

  function populateNamedPanel(panelId, items, iconMap, labels, type, idMap) {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    // Preserve the More settings footer across refreshes.
    const more = panel.querySelector(':scope > .rail-panel-more');
    panel.querySelectorAll(':scope > .rail-panel-item, :scope > .rail-panel-empty').forEach((el) => el.remove());

    const insertBeforeMore = (node) => {
      if (more) panel.insertBefore(node, more);
      else panel.appendChild(node);
    };

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'rail-panel-empty';
      empty.textContent = 'Nothing available';
      insertBeforeMore(empty);
      if (more) panel.appendChild(more);
      return;
    }

    items.forEach((item) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'rail-panel-item';
      row.dataset[type === 'base' ? 'base' : 'overlay'] = item;
      row.setAttribute('role', 'menuitem');

      const icon = document.createElement('span');
      icon.className = 'rail-panel-icon';
      icon.innerHTML = iconMap[item] || '';

      const name = document.createElement('span');
      name.className = 'rail-panel-name';
      name.textContent = labels[item] || item;

      row.appendChild(icon);
      row.appendChild(name);

      row.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (type === 'base') {
          // Drive the shared base <select> directly — avoids relying on hidden
          // buttons that live under display:none / pointer-events:none hosts.
          if (baseSelect && baseSelect.value !== item) {
            baseSelect.value = item;
            baseSelect.dispatchEvent(new Event('change'));
          }
          updateBaseButtonStates();
          updateLabelButtonVisibility();
          refreshOverlayPicker();
        } else {
          toggleOverlayByKey(item);
        }
      });

      insertBeforeMore(row);
    });
    if (more) panel.appendChild(more);
  }

  function refreshOverlayPicker() {
    const overlayKeys = allowedOver.filter((o) => isOverlayButtonAvailable(o));
    populateNamedPanel(
      'overlayPickerPanel',
      overlayKeys,
      favOverlayIcons,
      favOverlayOptions,
      'overlay',
      favOverlayBtnIds
    );
    updateOverlayButtonStates();
  }

  function refreshNamedPanels() {
    const mapKeys = allowedBases.filter((b) => favMapBtnIds[b] && document.getElementById(favMapBtnIds[b]));
    populateNamedPanel('mapPickerPanel', mapKeys, favMapIcons, favMapOptions, 'base', favMapBtnIds);
    refreshOverlayPicker();
    updateBaseButtonStates();
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
      const tip = favMapOptions[item] || favOverlayOptions[item] || toolOptions[item] || item;
      btn.dataset.tip = tip;
      btn.setAttribute('aria-label', tip);
      btn.removeAttribute('title');
      btn.dataset[type] = item;

      const originalBtnId = toolBtnIds[item];
      const originalBtn = document.getElementById(originalBtnId);

      if (type === 'tool' && originalBtn) {
        ['map-tool-btn--active', 'map-tool-btn--primary', 'map-tool-btn--danger', 'map-tool-btn--armed'].forEach((cls) => {
          if (originalBtn.classList.contains(cls)) btn.classList.add(cls);
        });
        if (originalBtn.innerHTML) btn.innerHTML = originalBtn.innerHTML;
        const liveTip = originalBtn.dataset.tip || originalBtn.getAttribute('aria-label') || tip;
        btn.dataset.tip = liveTip;
        btn.setAttribute('aria-label', liveTip);
      }

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (originalBtn) originalBtn.dispatchEvent(new MouseEvent('click', { bubbles: false, cancelable: true }));
        dropdown.classList.remove('open');
        updateMoreButtonsHighlight();
      });
      dropdown.appendChild(btn);
    });
  }

  function layoutToolsGroup() {
    const group = document.getElementById('toolBtnGroup');
    const moreBtn = document.getElementById('btnMoreTools');
    const moreWrapper = moreBtn?.closest('.more-btn-wrapper');
    if (!group || !moreWrapper) return;

    const keys = Object.keys(toolBtnIds).filter((k) => document.getElementById(toolBtnIds[k]));
    const mountNodeFor = (key, btn) => {
      const wrap = btn.closest('.more-btn-wrapper');
      // Keep tool wrappers that own a rail panel / settings host.
      if (wrap && wrap !== moreWrapper && wrap.querySelector('.rail-panel')) {
        return wrap;
      }
      return btn;
    };

    if (isMobileApp()) {
      // Mobile dock: Ruler sits next to Maps / Overlay.
      keys.forEach((k) => {
        const btn = document.getElementById(toolBtnIds[k]);
        if (!btn) return;
        const node = mountNodeFor(k, btn);
        if (k === 'ruler') {
          btn.style.display = '';
          group.appendChild(node);
        } else {
          btn.style.display = 'none';
          if (node.parentElement !== group) group.insertBefore(node, moreWrapper);
        }
      });
      moreWrapper.style.display = 'none';
      moreWrapper.hidden = true;
      document.getElementById('moreToolDropdown')?.classList.remove('open');
      populateMoreDropdown('moreToolDropdown', [], toolIcons, 'tool');
      return;
    }

    // Desktop rail: show every tool on the oval; no overflow menu needed.
    keys.forEach((k) => {
      const btn = document.getElementById(toolBtnIds[k]);
      if (!btn) return;
      btn.style.display = '';
      const node = mountNodeFor(k, btn);
      group.insertBefore(node, moreWrapper);
    });
    moreWrapper.style.display = 'none';
    document.getElementById('moreToolDropdown')?.classList.remove('open');
    populateMoreDropdown('moreToolDropdown', [], toolIcons, 'tool');
  }

  function applyToolbarOverflowLayout() {
    const rail = document.getElementById('sideRail');
    if (isMobileApp()) {
      // Bottom dock uses fixed touch targets; skip desktop compact/tight shrink.
      rail?.classList.remove('side-rail--compact', 'side-rail--tight');
    } else {
      const compactMode = window.matchMedia('(max-height: 780px), (max-width: 640px)').matches;
      const tightMode = window.matchMedia('(max-height: 620px)').matches;
      rail?.classList.toggle('side-rail--compact', compactMode);
      rail?.classList.toggle('side-rail--tight', tightMode);
    }

    layoutToolsGroup();
    refreshNamedPanels();
    updateMoreButtonsHighlight();
  }

  function applyFavorites(saveFirst = false) {
    if (saveFirst) saveFavorites();
    applyToolbarOverflowLayout();
  }

  let ignoreOutsideClickUntil = 0;

  function positionOpenPanel(panel) {
    if (!panel || !panel.classList.contains('open')) return;

    // Mobile bottom dock: panels are viewport-fixed via CSS.
    if (isMobileApp()) {
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.left = '';
      panel.style.right = '';
      panel.style.transform = '';
      return;
    }

    // Reset then clamp vertically so the panel stays inside the viewport.
    panel.style.top = '50%';
    panel.style.transform = 'translateY(-50%)';
    const rect = panel.getBoundingClientRect();
    const margin = 12;
    let shift = 0;
    if (rect.top < margin) shift = margin - rect.top;
    else if (rect.bottom > window.innerHeight - margin) {
      shift = (window.innerHeight - margin) - rect.bottom;
    }
    if (shift) {
      panel.style.transform = `translateY(calc(-50% + ${shift}px))`;
    }
  }

  function togglePanel(panelId, triggerId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const wasOpen = panel.classList.contains('open');
    closeAllPanels();
    if (!wasOpen) {
      panel.classList.add('open');
      document.getElementById(triggerId)?.classList.add('panel-open', 'active');
      document.getElementById(triggerId)?.setAttribute('aria-expanded', 'true');
      setMobileSheetOpen(true);
      // Mobile: ignore the leftover click/tap that would immediately close the panel.
      if (isMobileApp()) ignoreOutsideClickUntil = Date.now() + 450;
      requestAnimationFrame(() => positionOpenPanel(panel));
      if (panelId === 'mapPickerPanel' && typeof onMapsPickerOpen === 'function') {
        onMapsPickerOpen();
      }
    }
    updateSectionButtonStates();
  }

  function toggleToolsDropdown() {
    const dropdown = document.getElementById('moreToolDropdown');
    if (!dropdown) return;
    const wasOpen = dropdown.classList.contains('open');
    closeAllPanels();
    if (!wasOpen) dropdown.classList.add('open');
    updateMoreButtonsHighlight();
  }

  function init() {
    setupEmojiButtons();

    const sideRail = document.getElementById('sideRail');
    sideRail?.addEventListener('mousedown', (e) => e.stopPropagation());
    sideRail?.addEventListener('dblclick', (e) => e.stopPropagation());
    sideRail?.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    const isRailUiTarget = (target) => {
      const el = target instanceof Element ? target : target?.parentElement;
      return !!el?.closest(
        '#sideRail, #mobileSheetHost, #mapPickerPanel, #overlayPickerPanel, #moreToolDropdown, #kmlPickerPanel, #drawPickerPanel, .rail-panel-more-side, #drawMapMenu, #mobileSheetBackdrop'
      );
    };

    document.getElementById('btnMaps')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel('mapPickerPanel', 'btnMaps');
    });
    document.getElementById('btnOverlays')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel('overlayPickerPanel', 'btnOverlays');
    });
    document.getElementById('btnMoreTools')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleToolsDropdown();
    });

    document.getElementById('mapPickerPanel')?.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('overlayPickerPanel')?.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('moreToolDropdown')?.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('mobileSheetBackdrop')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAllPanels();
      updateMoreButtonsHighlight();
      updateSectionButtonStates();
    });

    // Click outside the rail closes any open panel (rail clicks are ignored so
    // icon toggle / in-panel picks are not immediately undone).
    document.addEventListener('click', (e) => {
      if (Date.now() < ignoreOutsideClickUntil) return;
      if (isRailUiTarget(e.target)) return;
      closeAllPanels();
      updateMoreButtonsHighlight();
      updateSectionButtonStates();
    });

    // Escape closes Maps / Overlays / More-tools / KML panels (capture so it wins over
    // the map's Escape → delete-selection handler in app.js).
    // Draw panel Esc is handled in app.js (cancel draft → mode → panel).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      const anyOpen = document.querySelector(
        '#mapPickerPanel.open, #overlayPickerPanel.open, #moreToolDropdown.open, #kmlPickerPanel.open'
      );
      if (!anyOpen) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeAllPanels();
      updateMoreButtonsHighlight();
    }, true);

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
    const toolBtnGroupEl = document.getElementById('toolBtnGroup');
    if (sideRailEl) new ResizeObserver(scheduleToolbarOverflowLayout).observe(sideRailEl);
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
    refreshOverlayPicker,
    populateFavoriteSelects,
    loadFavorites,
  };
}
