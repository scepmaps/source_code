/** Shared mobile client detection for scepmaps frontend routing. */

export function isMobileClient() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.has('desktop') || params.get('view') === 'desktop') return false;
    if (params.has('mobile') || params.get('view') === 'mobile') return true;
  } catch (_) { /* ignore */ }

  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  const ua = navigator.userAgent || '';
  const mobileUa = /Android|iPhone|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  // iPadOS may report as Macintosh with coarse pointer
  const iPad = /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  return mobileUa || iPad || (coarse && narrow);
}

export function appEntryHref() {
  return isMobileClient() ? 'mobile.html' : 'index.html';
}
