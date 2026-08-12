/**
 * Attach a More control to a rail panel. Settings open in a side panel
 * (left of the picker on desktop; stacked under More on mobile sheets).
 * Safe to call repeatedly.
 */
export function ensurePanelMore(panel, { sectionEl, onExpand } = {}) {
  if (!panel) return null;

  const isMobile = () => document.body.classList.contains('mobile-app');
  let more = panel.querySelector(':scope > .rail-panel-more');
  const host = panel.parentElement || panel;
  let side =
    host.querySelector(`:scope > .rail-panel-more-side[data-for="${panel.id}"]`) ||
    panel.querySelector(':scope > .rail-panel-more-side');

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
  else if (panel.lastElementChild !== more && !more.nextElementSibling?.classList?.contains('rail-panel-more-side')) {
    panel.appendChild(more);
  }

  placeSideHost(panel, side, isMobile());
  more._sideEl = side;
  panel._moreSideEl = side;

  if (sectionEl && sectionEl.parentElement !== side) {
    side.appendChild(sectionEl);
  }

  return more;
}

function placeSideHost(panel, side, mobile) {
  if (mobile) {
    // Keep side inside the sheet panel so it scrolls with the picker.
    if (side.parentElement !== panel) panel.appendChild(side);
    return;
  }
  const host = panel.parentElement || panel;
  if (side.parentElement !== host) host.appendChild(side);
}

function setMoreExpanded(panel, open) {
  const more = panel?.querySelector(':scope > .rail-panel-more');
  let side =
    panel?._moreSideEl ||
    more?._sideEl ||
    panel?.querySelector(':scope > .rail-panel-more-side') ||
    panel?.parentElement?.querySelector(`.rail-panel-more-side[data-for="${panel?.id}"]`);
  const btn = more?.querySelector('.rail-panel-more-btn');
  if (!more || !side) return;

  const mobile = document.body.classList.contains('mobile-app');
  placeSideHost(panel, side, mobile);

  more.classList.toggle('is-expanded', !!open);
  panel.classList.toggle('has-more-open', !!open);
  side.hidden = !open;
  side.classList.toggle('is-open', !!open);
  if (btn) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? 'Less' : 'More';
  }
  if (open) syncSidePosition(panel, side);
}

function syncSidePosition(panel, side) {
  if (!panel || !side) return;
  if (document.body.classList.contains('mobile-app')) {
    side.style.top = '';
    side.style.right = '';
    side.style.left = '';
    side.style.transform = '';
    return;
  }
  const host = panel.parentElement || panel;
  const panelRect = panel.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const gap = 10;
  side.style.right = `${Math.max(0, hostRect.right - panelRect.left + gap)}px`;
  side.style.top = `${Math.max(0, panelRect.top - hostRect.top)}px`;
  side.style.transform = 'none';
}

export function collapsePanelMore(panel) {
  setMoreExpanded(panel, false);
}

export function collapseAllPanelMore(root = document) {
  root.querySelectorAll('.rail-panel.has-more-open').forEach((panel) => {
    collapsePanelMore(panel);
  });
  root.querySelectorAll('.rail-panel-more-side.is-open, .rail-panel-more-side:not([hidden])').forEach((side) => {
    side.hidden = true;
    side.classList.remove('is-open');
  });
}
