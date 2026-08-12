/**
 * Attach a More / Less expander to a rail panel and optionally mount a settings section into it.
 * Safe to call repeatedly (reuses existing chrome; re-appends to keep More at the bottom).
 */
export function ensurePanelMore(panel, { sectionEl, onExpand } = {}) {
  if (!panel) return null;

  let more = panel.querySelector(':scope > .rail-panel-more');
  if (!more) {
    more = document.createElement('div');
    more.className = 'rail-panel-more';
    more.innerHTML = `
      <button type="button" class="rail-panel-more-btn" aria-expanded="false">More</button>
      <div class="rail-panel-more-body" hidden></div>
    `;
    const btn = more.querySelector('.rail-panel-more-btn');
    const body = more.querySelector('.rail-panel-more-body');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = !more.classList.contains('is-expanded');
      more.classList.toggle('is-expanded', open);
      body.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? 'Less' : 'More';
      if (open && typeof more._onExpand === 'function') more._onExpand();
    });
  }

  if (typeof onExpand === 'function') more._onExpand = onExpand;

  // Keep More as the last child so grid items stay above it after re-populate.
  if (more.parentElement !== panel || panel.lastElementChild !== more) {
    panel.appendChild(more);
  }

  if (sectionEl) {
    const body = more.querySelector('.rail-panel-more-body');
    if (body && sectionEl.parentElement !== body) body.appendChild(sectionEl);
  }

  return more;
}

export function collapsePanelMore(panel) {
  const more = panel?.querySelector(':scope > .rail-panel-more');
  if (!more) return;
  more.classList.remove('is-expanded');
  const body = more.querySelector('.rail-panel-more-body');
  const btn = more.querySelector('.rail-panel-more-btn');
  if (body) body.hidden = true;
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = 'More';
  }
}
