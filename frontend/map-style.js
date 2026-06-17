/** MapLibre needs absolute URLs when the style is passed as an inline object. */

/**
 * Returns a MapLibre transformRequest callback that attaches the current Bearer
 * token to every request routed through our own proxy (same origin).
 * Without this, MapLibre workers 401 on auth-gated tile/sprite/glyph routes.
 */
export function makeArcgisTransformRequest(getToken) {
  return (url, _resourceType) => {
    try {
      const reqOrigin = new URL(url).origin;
      if (reqOrigin !== window.location.origin) return { url };
    } catch (_) {
      return { url };
    }
    const token = getToken();
    if (!token) return { url };
    return { url, headers: { Authorization: `Bearer ${token}` } };
  };
}

export function absolutizeMapStyleUrls(style) {
  const origin = window.location.origin;
  const abs = (url) => {
    if (typeof url !== 'string' || !url.startsWith('/')) return url;
    return `${origin}${url}`;
  };

  const out = structuredClone(style);
  if (typeof out.sprite === 'string') out.sprite = abs(out.sprite);
  if (typeof out.glyphs === 'string') out.glyphs = abs(out.glyphs);

  if (out.sources && typeof out.sources === 'object') {
    for (const source of Object.values(out.sources)) {
      if (!source || typeof source !== 'object') continue;
      if (Array.isArray(source.tiles)) source.tiles = source.tiles.map(abs);
      if (typeof source.url === 'string') source.url = abs(source.url);
    }
  }

  return out;
}
