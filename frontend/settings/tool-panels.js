/** Contextual tool settings panels (density / shared helpers). */

import { iconHtml } from '../toolbar/icons.js?v=20260806t';

function switchRow({ id, label, checked = false, title = '' }) {
  return `
    <label class="tool-settings-switch" ${title ? `title="${title}"` : ''}>
      <span>${label}</span>
      <span class="settings-switch">
        <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />
        <span class="settings-switch-slider" aria-hidden="true"></span>
      </span>
    </label>
  `;
}

function parseRgba(color, fallbackHex, fallbackOpacity) {
  const match = String(color || '').match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!match) return { hex: fallbackHex, opacity: fallbackOpacity };
  const hex = `#${[match[1], match[2], match[3]].map((x) => parseInt(x, 10).toString(16).padStart(2, '0')).join('')}`;
  return { hex, opacity: match[4] != null ? parseFloat(match[4]) : 1 };
}

function hexToRgba(hex, opacity) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

export function initDensitySettingsPanel(opts) {
  const {
    userRef,
    setUser,
    getToken,
    API_BASE,
    allowedOver,
    updateDensityOpacity,
    updateDensityBorderColors,
  } = opts;

  if (!allowedOver?.includes('density')) {
    return { close: () => {}, isOpen: () => false };
  }

  let panelEl = null;
  let saveTimer = null;
  let gearLegendBtn = null;

  function currentPrefs() {
    const user = userRef?.() || {};
    const opacity = user.density_opacity !== undefined ? user.density_opacity : 0.65;
    const border = parseRgba(user.density_border_color, '#ffffff', 0.2);
    const hover = parseRgba(user.density_border_hover_color, '#000000', 0.9);
    return { opacity, border, hover };
  }

  function ensurePanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = 'densitySettingsPanel';
    panelEl.className = 'tool-settings-sheet density-settings-sheet';
    panelEl.setAttribute('role', 'dialog');
    panelEl.setAttribute('aria-label', 'Density appearance');
    panelEl.innerHTML = `
      <div class="tool-settings-header">
        <span class="tool-settings-title">Density appearance</span>
        <button type="button" class="tool-settings-close" id="densitySettingsClose" aria-label="Close">&times;</button>
      </div>
      <p class="tool-settings-hint">Changes apply immediately and sync to your account.</p>
      <div class="tool-settings-field">
        <label for="densityPanelOpacity">Layer opacity</label>
        <div class="tool-settings-range-row">
          <input type="range" id="densityPanelOpacity" min="0" max="1" step="0.05" />
          <span id="densityPanelOpacityVal">65%</span>
        </div>
      </div>
      <div class="tool-settings-field">
        <label for="densityPanelBorderColor">Border</label>
        <div class="tool-settings-color-row">
          <input type="color" id="densityPanelBorderColor" />
          <input type="range" id="densityPanelBorderOpacity" min="0" max="1" step="0.1" />
          <span id="densityPanelBorderOpacityVal">20%</span>
        </div>
      </div>
      <div class="tool-settings-field">
        <label for="densityPanelHoverColor">Hover border</label>
        <div class="tool-settings-color-row">
          <input type="color" id="densityPanelHoverColor" />
          <input type="range" id="densityPanelHoverOpacity" min="0" max="1" step="0.1" />
          <span id="densityPanelHoverOpacityVal">90%</span>
        </div>
      </div>
    `;
    panelEl.addEventListener('click', (e) => e.stopPropagation());
    panelEl.querySelector('#densitySettingsClose')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      close();
    });

    const bindLive = () => {
      const opacityEl = panelEl.querySelector('#densityPanelOpacity');
      const opacityVal = panelEl.querySelector('#densityPanelOpacityVal');
      const borderColor = panelEl.querySelector('#densityPanelBorderColor');
      const borderOpacity = panelEl.querySelector('#densityPanelBorderOpacity');
      const borderOpacityVal = panelEl.querySelector('#densityPanelBorderOpacityVal');
      const hoverColor = panelEl.querySelector('#densityPanelHoverColor');
      const hoverOpacity = panelEl.querySelector('#densityPanelHoverOpacity');
      const hoverOpacityVal = panelEl.querySelector('#densityPanelHoverOpacityVal');

      const applyVisual = () => {
        const opacity = parseFloat(opacityEl.value);
        opacityVal.textContent = `${Math.round(opacity * 100)}%`;
        borderOpacityVal.textContent = `${Math.round(parseFloat(borderOpacity.value) * 100)}%`;
        hoverOpacityVal.textContent = `${Math.round(parseFloat(hoverOpacity.value) * 100)}%`;
        updateDensityOpacity?.(opacity);
        updateDensityBorderColors?.(
          hexToRgba(borderColor.value, parseFloat(borderOpacity.value)),
          hexToRgba(hoverColor.value, parseFloat(hoverOpacity.value))
        );
        schedulePersist();
      };

      [opacityEl, borderColor, borderOpacity, hoverColor, hoverOpacity].forEach((el) => {
        el?.addEventListener('input', applyVisual);
      });
    };

    bindLive();
    document.body.appendChild(panelEl);
    return panelEl;
  }

  function loadIntoForm() {
    ensurePanel();
    const prefs = currentPrefs();
    const opacityEl = panelEl.querySelector('#densityPanelOpacity');
    const opacityVal = panelEl.querySelector('#densityPanelOpacityVal');
    const borderColor = panelEl.querySelector('#densityPanelBorderColor');
    const borderOpacity = panelEl.querySelector('#densityPanelBorderOpacity');
    const borderOpacityVal = panelEl.querySelector('#densityPanelBorderOpacityVal');
    const hoverColor = panelEl.querySelector('#densityPanelHoverColor');
    const hoverOpacity = panelEl.querySelector('#densityPanelHoverOpacity');
    const hoverOpacityVal = panelEl.querySelector('#densityPanelHoverOpacityVal');

    opacityEl.value = String(prefs.opacity);
    opacityVal.textContent = `${Math.round(prefs.opacity * 100)}%`;
    borderColor.value = prefs.border.hex;
    borderOpacity.value = String(prefs.border.opacity);
    borderOpacityVal.textContent = `${Math.round(prefs.border.opacity * 100)}%`;
    hoverColor.value = prefs.hover.hex;
    hoverOpacity.value = String(prefs.hover.opacity);
    hoverOpacityVal.textContent = `${Math.round(prefs.hover.opacity * 100)}%`;
  }

  function schedulePersist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 500);
  }

  async function persist() {
    if (!panelEl) return;
    const opacity = parseFloat(panelEl.querySelector('#densityPanelOpacity').value);
    const border = hexToRgba(
      panelEl.querySelector('#densityPanelBorderColor').value,
      parseFloat(panelEl.querySelector('#densityPanelBorderOpacity').value)
    );
    const hover = hexToRgba(
      panelEl.querySelector('#densityPanelHoverColor').value,
      parseFloat(panelEl.querySelector('#densityPanelHoverOpacity').value)
    );
    try {
      const res = await fetch(`${API_BASE}/auth/preferences`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          density_opacity: opacity,
          density_border_color: border,
          density_border_hover_color: hover,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.user) {
        setUser?.(data.user);
        try {
          localStorage.setItem('user', JSON.stringify(data.user));
        } catch (_) {
          /* ignore */
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  function positionNear(anchor) {
    ensurePanel();
    if (!anchor || document.body.classList.contains('mobile-app')) {
      panelEl.style.left = '50%';
      panelEl.style.right = 'auto';
      panelEl.style.bottom = '96px';
      panelEl.style.top = 'auto';
      panelEl.style.transform = 'translateX(-50%)';
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const width = 280;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    let top = rect.top - 12;
    panelEl.style.transform = 'none';
    panelEl.style.right = 'auto';
    panelEl.style.bottom = 'auto';
    panelEl.style.left = `${left}px`;
    // Prefer above the legend; fall back below if clipped.
    panelEl.style.top = '0px';
    panelEl.classList.add('open');
    const h = panelEl.getBoundingClientRect().height || 280;
    if (top - h < 12) top = rect.bottom + 12;
    else top = top - h;
    panelEl.style.top = `${Math.max(12, top)}px`;
  }

  function open(anchor) {
    loadIntoForm();
    positionNear(anchor || document.getElementById('densityLegend'));
    panelEl.classList.add('open');
    gearLegendBtn?.classList.add('is-open');
    document.getElementById('overlayDensityGear')?.classList.add('is-open');
  }

  function close() {
    panelEl?.classList.remove('open');
    gearLegendBtn?.classList.remove('is-open');
    document.getElementById('overlayDensityGear')?.classList.remove('is-open');
  }

  function isOpen() {
    return !!panelEl?.classList.contains('open');
  }

  function toggle(anchor) {
    if (isOpen()) close();
    else open(anchor);
  }

  function ensureLegendGear() {
    const legend = document.getElementById('densityLegend');
    if (!legend || gearLegendBtn) return;
    const row = legend.querySelector('.info-row') || legend;
    gearLegendBtn = document.createElement('button');
    gearLegendBtn.type = 'button';
    gearLegendBtn.id = 'densityLegendGear';
    gearLegendBtn.className = 'tool-settings-gear density-legend-gear';
    gearLegendBtn.title = 'Density appearance';
    gearLegendBtn.setAttribute('aria-label', 'Density appearance');
    gearLegendBtn.innerHTML = iconHtml('settings') || '⚙';
    gearLegendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggle(legend);
    });
    row.appendChild(gearLegendBtn);
  }

  function ensureOverlayGear(panel) {
    if (!panel) return;
    let header = panel.querySelector('.rail-panel-toolbar');
    if (!header) {
      header = document.createElement('div');
      header.className = 'rail-panel-toolbar';
      header.innerHTML = `
        <span class="rail-panel-toolbar-title">Overlays</span>
        <button type="button" class="tool-settings-gear" id="overlayDensityGear" title="Density appearance" aria-label="Density appearance">
          ${iconHtml('settings') || '⚙'}
        </button>
      `;
      panel.insertBefore(header, panel.firstChild);
      header.querySelector('#overlayDensityGear')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(header);
      });
    }
  }

  ensureLegendGear();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      close();
      e.stopPropagation();
    }
  });
  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    const t = e.target;
    if (panelEl?.contains(t)) return;
    if (gearLegendBtn?.contains(t)) return;
    if (t?.closest?.('#overlayDensityGear')) return;
    close();
  });

  return {
    open,
    close,
    isOpen,
    toggle,
    ensureOverlayGear,
    switchRow,
  };
}

export { switchRow, hexToRgba, parseRgba };
