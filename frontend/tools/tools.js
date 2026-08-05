import { iconHtml } from '../toolbar/icons.js';

function setBoxButtonState(btn, state) {
  btn.classList.remove('map-tool-btn--danger', 'map-tool-btn--armed', 'map-tool-btn--primary');
  if (state === 'delete') {
    btn.classList.add('map-tool-btn--danger');
    btn.innerHTML = iconHtml('trash');
    btn.title = 'Delete selection box';
    return;
  }
  if (state === 'place') {
    btn.classList.add('map-tool-btn--armed');
    btn.innerHTML = iconHtml('box');
    btn.title = 'Place selection box';
    return;
  }
  btn.classList.add('map-tool-btn--primary');
  btn.innerHTML = iconHtml('box');
  btn.title = 'Draw selection box';
}

function createToolButton({ className, title, html, text, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `emoji-btn map-tool-btn ${className}`.trim();
  btn.title = title;
  if (html) btn.innerHTML = html;
  else if (text) btn.textContent = text;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (typeof onClick === 'function') onClick(e);
  });
  return btn;
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
    onHideInlineHgtButton
  } = opts;

  let boxBtn = null;
  const host = mountEl || document.getElementById('toolBtnGroup');
  if (!host) {
    console.warn('[tools] No mount element for map tools');
    return { refreshBoxButton: () => {} };
  }
  host.innerHTML = '';

  const rulerBtn = createToolButton({
    className: 'map-tool-btn--ruler',
    title: 'Measure distance: Click to add points, drag to move, click point to delete',
    html: iconHtml('ruler'),
    onClick: () => {
      if (typeof onToggleRuler === 'function') onToggleRuler();
    },
  });
  host.appendChild(rulerBtn);
  if (typeof onRulerButtonReady === 'function') onRulerButtonReady(rulerBtn);

  boxBtn = createToolButton({
    className: 'map-tool-btn--box',
    title: 'Draw selection box',
    html: iconHtml('box'),
    onClick: () => {
      if (typeof onBoxClick === 'function') onBoxClick();
      if (typeof getBoxButtonState === 'function') {
        setBoxButtonState(boxBtn, getBoxButtonState());
      }
    },
  });
  setBoxButtonState(boxBtn, 'draw');
  host.appendChild(boxBtn);

  if (allowedTools.includes('hgt')) {
    const hgtBtn = createToolButton({
      className: 'map-tool-btn--hgt',
      title: 'Draw HGT selection box',
      text: 'HGT',
      onClick: () => {
        if (typeof onHgtClick === 'function') onHgtClick();
      },
    });
    host.appendChild(hgtBtn);
    if (typeof onHgtButtonReady === 'function') onHgtButtonReady(hgtBtn);
  } else if (typeof onHideInlineHgtButton === 'function') {
    onHideInlineHgtButton();
  }

  return {
    refreshBoxButton: () => {
      if (!boxBtn || typeof getBoxButtonState !== 'function') return;
      setBoxButtonState(boxBtn, getBoxButtonState());
    }
  };
}
