/**
 * Attach a More control to a rail panel. Settings open in a side panel
 * aligned to the picker (desktop) or stacked under More (mobile sheets).
 * Safe to call repeatedly.
 */

function isMobileApp() {
  return document.body.classList.contains('mobile-app');
}

function getSideForPanel(panel) {
  if (!panel) return null;
  return (
    panel._moreSideEl ||
    panel.querySelector(':scope > .rail-panel-more-side') ||
    panel.parentElement?.querySelector(`.rail-panel-more-side[data-for="${panel.id}"]`) ||
    document.querySelector(`.rail-panel-more-side[data-for="${panel.id}"]`)
  );
}

export function ensurePanelMore(panel, { sectionEl, onExpand } = {}) {
  if (!panel) return null;

  let more = panel.querySelector(':scope > .rail-panel-more');
  let side = getSideForPanel(panel);

  if (!more) {
    more = document.createElement('div');
    more.className = 'rail-panel-more';
    more.innerHTML = `<button type="button" class="rail-panel-more-btn" aria-expanded="false">More</button>`;
    const btn = more.querySelector('.rail-panel-more-btn');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = !more.classList.contains('is-expanded');
      setMoreExpanded(panel, open);
      if (open && typeof more._onExpand === 'function') more._onExpand();
    });
  }

  if (!side) {
    side = document.createElement('div');
    side.className = 'rail-panel-more-side';
    if (panel.id) side.dataset.for = panel.id;
    side.hidden = true;
    side.setAttribute('role', 'region');
    side.setAttribute('aria-label', 'Settings');
    side.addEventListener('click', (e) => e.stopPropagation());
  }

  if (typeof onExpand === 'function') more._onExpand = onExpand;

  if (more.parentElement !== panel) panel.appendChild(more);
  else panel.appendChild(more);

  placeSideHost(panel, side);
  more._sideEl = side;
  panel._moreSideEl = side;

  if (sectionEl && sectionEl.parentElement !== side) {
    side.appendChild(sectionEl);
  }

  ensureGlobalSync();
  return more;
}

function placeSideHost(panel, side) {
  if (isMobileApp()) {
    clearFixedStyles(side);
    if (side.parentElement !== panel) panel.appendChild(side);
    return;
  }
  // Fixed to the viewport so rail transforms don't skew alignment.
  if (side.parentElement !== document.body) document.body.appendChild(side);
}

function clearFixedStyles(side) {
  if (!side) return;
  side.style.position = '';
  side.style.left = '';
  side.style.right = '';
  side.style.top = '';
  side.style.width = '';
  side.style.maxHeight = '';
  side.style.height = '';
  side.style.transform = '';
}

function setMoreExpanded(panel, open) {
  const more = panel?.querySelector(':scope > .rail-panel-more');
  const side = getSideForPanel(panel);
  const btn = more?.querySelector('.rail-panel-more-btn');
  if (!more || !side) return;

  placeSideHost(panel, side);

  more.classList.toggle('is-expanded', !!open);
  panel.classList.toggle('has-more-open', !!open);
  side.hidden = !open;
  side.classList.toggle('is-open', !!open);
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? 'Less' : 'More';
  }
  if (open) {
    // Double rAF: wait for picker layout / clamp before measuring.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => syncSidePosition(panel, side));
    });
  } else {
    clearFixedStyles(side);
  }
}

export function syncSidePosition(panel, side = getSideForPanel(panel)) {
  if (!panel || !side || side.hidden || !side.classList.contains('is-open')) return;
  if (isMobileApp()) {
    clearFixedStyles(side);
    return;
  }
  if (!panel.classList.contains('open')) return;

  const rect = panel.getBoundingClientRect();
  const gap = 10;
  const margin = 12;
  const maxWidth = Math.min(300, Math.max(200, window.innerWidth - margin * 2));
  let width = maxWidth;
  let left = rect.left - gap - width;
  if (left < margin) {
    // Not enough room on the left — shrink, then clamp.
    width = Math.max(200, rect.left - gap - margin);
    left = margin;
  }

  let top = rect.top;
  const maxHeight = Math.max(160, window.innerHeight - margin * 2);
  let heightCap = Math.min(maxHeight, Math.max(rect.height, window.innerHeight * 0.72));

  if (top + heightCap > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - margin - heightCap);
  }
  if (top < margin) top = margin;
  heightCap = Math.min(heightCap, window.innerHeight - top - margin);

  side.style.position = 'fixed';
  side.style.right = 'auto';
  side.style.left = `${Math.round(left)}px`;
  side.style.top = `${Math.round(top)}px`;
  side.style.width = `${Math.round(width)}px`;
  side.style.maxHeight = `${Math.round(heightCap)}px`;
  side.style.height = 'auto';
  side.style.transform = 'none';
}

/** Re-align any open More side panels (call after picker reposition / resize). */
export function syncOpenPanelMore() {
  document.querySelectorAll('.rail-panel.has-more-open').forEach((panel) => {
    syncSidePosition(panel);
  });
}

export function collapsePanelMore(panel) {
  setMoreExpanded(panel, false);
}

export function collapseAllPanelMore(root = document) {
  root.querySelectorAll('.rail-panel.has-more-open').forEach((panel) => {
    collapsePanelMore(panel);
  });
  document.querySelectorAll('.rail-panel-more-side.is-open').forEach((side) => {
    side.hidden = true;
    side.classList.remove('is-open');
    clearFixedStyles(side);
  });
}

let syncBound = false;
function ensureGlobalSync() {
  if (syncBound) return;
  syncBound = true;
  window.addEventListener('resize', () => syncOpenPanelMore(), { passive: true });
  window.addEventListener('scroll', () => syncOpenPanelMore(), { passive: true, capture: true });
}
