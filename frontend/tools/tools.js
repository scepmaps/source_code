import { iconHtml } from '../toolbar/icons.js';

export const TOOL_BTN_IDS = {
  ruler: 'btnRuler',
  box: 'btnBox',
  hgt: 'btnHgt',
  draw: 'btnDraw',
  kml: 'btnKml',
};

export const TOOL_LABELS = {
  ruler: 'Ruler',
  box: 'Selection Box',
  hgt: 'HGT',
  draw: 'Draw',
  kml: 'KML',
};

export const TOOL_ICONS = {
  ruler: iconHtml('ruler'),
  box: iconHtml('box'),
  hgt: '<span class="tool-hgt-label">HGT</span>',
  draw: iconHtml('draw'),
  kml: iconHtml('kml'),
};

function setBoxButtonState(btn, state) {
  btn.classList.remove('map-tool-btn--danger', 'map-tool-btn--armed', 'map-tool-btn--primary', 'map-tool-btn--active');
  if (state === 'delete') {
    btn.classList.add('map-tool-btn--danger');
    btn.innerHTML = iconHtml('trash');
    setButtonTip(btn, 'Delete Box');
    return;
  }
  if (state === 'place') {
    btn.classList.add('map-tool-btn--armed');
    btn.innerHTML = iconHtml('box');
    setButtonTip(btn, 'Place Box');
    return;
  }
  // Idle: no accent classes — previously --primary kept the icon permanently lit.
  btn.innerHTML = iconHtml('box');
  setButtonTip(btn, 'Selection Box');
}

function createToolButton({ id, className, title, html, text, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = id;
  btn.className = `emoji-btn map-tool-btn ${className}`.trim();
  btn.dataset.tip = title;
  btn.setAttribute('aria-label', title);
  if (html) btn.innerHTML = html;
  else if (text) btn.textContent = text;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof onClick === 'function') onClick(e);
  });
  return btn;
}

function setButtonTip(btn, label) {
  if (!btn) return;
  btn.dataset.tip = label;
  btn.setAttribute('aria-label', label);
  btn.removeAttribute('title');
}

export function initMapToolControls(opts) {
  const {
    allowedTools = [],
    mountEl = document.getElementById('toolBtnGroup'),
    onRulerButtonReady,
    onBoxClick,
    getBoxButtonState,
    onToggleRuler,
    onHgtButtonReady,
    onHgtClick,
    onHideInlineHgtButton,
    onKmlButtonReady,
    onDrawButtonReady,
    isMobileApp = false,
    onToolsReady,
  } = opts;

  let boxBtn = null;
  const host = mountEl || document.getElementById('toolBtnGroup');
  if (!host) {
    console.warn('[tools] No mount element for map tools');
    return { refreshBoxButton: () => {} };
  }

  // Preserve the "more" wrapper if present; rebuild tool buttons around it.
  const moreWrapper = host.querySelector('.more-btn-wrapper');
  [...host.children].forEach((child) => {
    if (child !== moreWrapper) child.remove();
  });

  const insertBeforeMore = (el) => {
    if (moreWrapper) host.insertBefore(el, moreWrapper);
    else host.appendChild(el);
  };

  const rulerWrap = document.createElement('div');
  rulerWrap.className = 'more-btn-wrapper';
  const rulerBtn = createToolButton({
    id: TOOL_BTN_IDS.ruler,
    className: 'map-tool-btn--ruler',
    title: 'Ruler',
    html: iconHtml('ruler'),
    onClick: () => {
      if (typeof onToggleRuler === 'function') onToggleRuler();
    },
  });
  const rulerPanel = document.createElement('div');
  rulerPanel.id = 'rulerSettingsPanel';
  rulerPanel.className = 'rail-panel ruler-settings-panel';
  rulerPanel.setAttribute('role', 'dialog');
  rulerPanel.setAttribute('aria-label', 'Ruler settings');
  rulerPanel.addEventListener('click', (e) => e.stopPropagation());
  const rulerMoreBtn = document.createElement('button');
  rulerMoreBtn.type = 'button';
  rulerMoreBtn.id = 'btnRulerMore';
  rulerMoreBtn.className = 'emoji-btn map-tool-btn map-tool-btn--ruler-more';
  rulerMoreBtn.dataset.tip = 'Ruler settings';
  rulerMoreBtn.setAttribute('aria-label', 'Ruler settings');
  rulerMoreBtn.setAttribute('aria-haspopup', 'true');
  rulerMoreBtn.setAttribute('aria-expanded', 'false');
  rulerMoreBtn.innerHTML = iconHtml('settings') || '⚙';
  rulerMoreBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wasOpen = rulerPanel.classList.contains('open');
    document.querySelectorAll(
      '#mapPickerPanel, #overlayPickerPanel, #moreToolDropdown, #kmlPickerPanel, #drawPickerPanel'
    ).forEach((el) => el.classList.remove('open'));
    document.getElementById('btnMaps')?.classList.remove('panel-open', 'active');
    document.getElementById('btnOverlays')?.classList.remove('panel-open', 'active');
    document.getElementById('btnMaps')?.setAttribute('aria-expanded', 'false');
    document.getElementById('btnOverlays')?.setAttribute('aria-expanded', 'false');
    if (wasOpen) {
      rulerPanel.classList.remove('open');
      rulerMoreBtn.classList.remove('panel-open', 'map-tool-btn--active');
      rulerMoreBtn.setAttribute('aria-expanded', 'false');
    } else {
      rulerPanel.classList.add('open');
      rulerMoreBtn.classList.add('panel-open', 'map-tool-btn--active');
      rulerMoreBtn.setAttribute('aria-expanded', 'true');
    }
  });
  rulerWrap.appendChild(rulerBtn);
  rulerWrap.appendChild(rulerMoreBtn);
  rulerWrap.appendChild(rulerPanel);
  insertBeforeMore(rulerWrap);
  if (typeof onRulerButtonReady === 'function') onRulerButtonReady(rulerBtn);

  boxBtn = createToolButton({
    id: TOOL_BTN_IDS.box,
    className: 'map-tool-btn--box',
    title: 'Selection Box',
    html: iconHtml('box'),
    onClick: () => {
      if (typeof onBoxClick === 'function') onBoxClick();
      if (typeof getBoxButtonState === 'function') {
        setBoxButtonState(boxBtn, getBoxButtonState());
      }
    },
  });
  setBoxButtonState(boxBtn, 'draw');
  insertBeforeMore(boxBtn);

  if (allowedTools.includes('hgt')) {
    const hgtBtn = createToolButton({
      id: TOOL_BTN_IDS.hgt,
      className: 'map-tool-btn--hgt',
      title: 'HGT',
      text: 'HGT',
      onClick: () => {
        if (typeof onHgtClick === 'function') onHgtClick();
      },
    });
    insertBeforeMore(hgtBtn);
    if (typeof onHgtButtonReady === 'function') onHgtButtonReady(hgtBtn);
  } else if (typeof onHideInlineHgtButton === 'function') {
    onHideInlineHgtButton();
  }

  if (!isMobileApp && allowedTools.includes('draw')) {
    const drawBtn = createToolButton({
      id: TOOL_BTN_IDS.draw,
      className: 'map-tool-btn--draw',
      title: 'Draw',
      html: iconHtml('draw'),
      onClick: () => {},
    });
    insertBeforeMore(drawBtn);
    if (typeof onDrawButtonReady === 'function') onDrawButtonReady(drawBtn);
  }

  if (allowedTools.includes('kml')) {
    const kmlBtn = createToolButton({
      id: TOOL_BTN_IDS.kml,
      className: 'map-tool-btn--kml',
      title: 'KML overlays',
      html: iconHtml('kml'),
      onClick: () => {},
    });
    insertBeforeMore(kmlBtn);
    if (typeof onKmlButtonReady === 'function') onKmlButtonReady(kmlBtn);
  }

  if (typeof onToolsReady === 'function') onToolsReady();

  return {
    refreshBoxButton: () => {
      if (!boxBtn || typeof getBoxButtonState !== 'function') return;
      setBoxButtonState(boxBtn, getBoxButtonState());
    }
  };
}
