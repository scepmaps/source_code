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

export function initMapToolControls(opts) {
  const {
    L,
    map,
    allowedTools = [],
    onRulerButtonReady,
    onBoxClick,
    getBoxButtonState,
    onToggleRuler,
    onHgtButtonReady,
    onHgtClick,
    onHideInlineHgtButton
  } = opts;

  let boxBtn = null;

  const RulerControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      const container = L.DomUtil.create('div', 'leaflet-bar map-tool-container');
      const btn = L.DomUtil.create('a', 'map-tool-btn map-tool-btn--ruler', container);
      btn.href = '#';
      btn.title = 'Measure distance: Click to add points, drag to move, click point to delete';
      btn.innerHTML = iconHtml('ruler');
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        if (typeof onToggleRuler === 'function') onToggleRuler();
      });
      if (typeof onRulerButtonReady === 'function') onRulerButtonReady(btn);
      return container;
    }
  });
  map.addControl(new RulerControl());

  const BoxControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      const container = L.DomUtil.create('div', 'leaflet-bar map-tool-container');
      const btn = L.DomUtil.create('a', 'map-tool-btn map-tool-btn--box', container);
      btn.href = '#';
      boxBtn = btn;
      setBoxButtonState(btn, 'draw');
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        if (typeof onBoxClick === 'function') onBoxClick();
        if (typeof getBoxButtonState === 'function') {
          setBoxButtonState(btn, getBoxButtonState());
        }
      });
      return container;
    }
  });
  map.addControl(new BoxControl());

  if (allowedTools.includes('hgt')) {
    const HgtControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        const container = L.DomUtil.create('div', 'leaflet-bar map-tool-container');
        const btn = L.DomUtil.create('a', 'map-tool-btn map-tool-btn--hgt', container);
        btn.href = '#';
        btn.textContent = 'HGT';
        btn.title = 'Draw HGT selection box';
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', (e) => {
          L.DomEvent.preventDefault(e);
          if (typeof onHgtClick === 'function') onHgtClick();
        });
        if (typeof onHgtButtonReady === 'function') onHgtButtonReady(btn);
        return container;
      }
    });
    map.addControl(new HgtControl());
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
