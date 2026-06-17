"""Rewrite ArcGIS style/resource URLs to local proxies — keeps API key server-side."""

from __future__ import annotations

import base64
import copy
import re
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

_ARCGIS_HOST_SUFFIXES = ("arcgis.com", "arcgisonline.com")


def strip_token_param(url: str) -> str:
    parsed = urlparse(url)
    if not parsed.query:
        return url
    qs = parse_qs(parsed.query, keep_blank_values=True)
    qs.pop("token", None)
    if not qs:
        return urlunparse(parsed._replace(query=""))
    flat: dict[str, Any] = {}
    for key, values in qs.items():
        flat[key] = values[0] if len(values) == 1 else values
    return urlunparse(parsed._replace(query=urlencode(flat, doseq=True)))


def is_arcgis_host(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return any(host == suffix or host.endswith("." + suffix) for suffix in _ARCGIS_HOST_SUFFIXES)


def validate_arcgis_url(url: str) -> str:
    clean = strip_token_param(url)
    if not is_arcgis_host(clean):
        raise ValueError("Upstream URL is not an allowed ArcGIS host")
    return clean


def encode_upstream(url: str) -> str:
    return base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")


def decode_upstream(enc: str) -> str:
    pad = "=" * (-len(enc) % 4)
    return base64.urlsafe_b64decode((enc + pad).encode()).decode()


def vector_tile_proxy_url(template: str, base_url: str = "") -> str:
    clean = validate_arcgis_url(template)
    return f"{base_url}/tiles/arcgis/vector/{{z}}/{{x}}/{{y}}.pbf?u={encode_upstream(clean)}"


def sprite_proxy_url(sprite_base: str, base_url: str = "") -> str:
    clean = validate_arcgis_url(sprite_base)
    return f"{base_url}/api/arcgis/res/{encode_upstream(clean)}"


def glyphs_proxy_url(glyphs_template: str, base_url: str = "") -> str:
    clean = validate_arcgis_url(glyphs_template)
    return f"{base_url}/api/arcgis/glyphs/{encode_upstream(clean)}/{{fontstack}}/{{range}}.pbf"


def tilejson_proxy_url(tilejson_url: str, base_url: str = "") -> str:
    clean = validate_arcgis_url(tilejson_url)
    return f"{base_url}/api/arcgis/tilejson?u={encode_upstream(clean)}"


def rewrite_arcgis_style(style_json: dict, base_url: str = "") -> dict:
    """Deep-copy style JSON and replace ArcGIS URLs with absolute local proxy URLs.

    Pass base_url (e.g. 'https://pamerkuf.scep.city') so MapLibre workers can
    construct Request objects — they reject root-relative paths.
    """
    style = copy.deepcopy(style_json)
    _rewrite_obj(style, base_url=base_url)
    return style


def rewrite_tile_url(url: str, *, upstream_base: str | None = None, base_url: str = "") -> str:
    if not isinstance(url, str):
        return url
    clean = strip_token_param(url)
    if is_arcgis_host(clean):
        if "{z}" in clean and ("/tile/" in clean or "VectorTileServer" in clean or ".pbf" in clean):
            return vector_tile_proxy_url(clean, base_url=base_url)
        return clean
    # ArcGIS TileJSON often uses paths relative to the VectorTileServer root.
    if upstream_base and "{z}" in clean:
        upstream = upstream_base.rstrip("/")
        rel = clean.lstrip("/")
        return vector_tile_proxy_url(f"{upstream}/{rel}", base_url=base_url)
    return clean


def rewrite_tilejson(tilejson: dict, upstream_base: str, base_url: str = "") -> dict:
    """Rewrite TileJSON tile templates to local proxy paths."""
    if not isinstance(tilejson, dict):
        return tilejson
    tiles = tilejson.get("tiles")
    if isinstance(tiles, list):
        tilejson["tiles"] = [rewrite_tile_url(u, upstream_base=upstream_base, base_url=base_url) for u in tiles]
    return tilejson


def _rewrite_obj(obj: Any, base_url: str = "") -> None:
    if isinstance(obj, dict):
        sprite = obj.get("sprite")
        if isinstance(sprite, str) and is_arcgis_host(sprite):
            obj["sprite"] = sprite_proxy_url(sprite, base_url=base_url)

        glyphs = obj.get("glyphs")
        if isinstance(glyphs, str) and is_arcgis_host(glyphs):
            obj["glyphs"] = glyphs_proxy_url(glyphs, base_url=base_url)

        sources = obj.get("sources")
        if isinstance(sources, dict):
            for source in sources.values():
                if not isinstance(source, dict):
                    continue
                tiles = source.get("tiles")
                if isinstance(tiles, list):
                    source["tiles"] = [rewrite_tile_url(u, base_url=base_url) for u in tiles]
                    # MapLibre prefers source.url (TileJSON) over tiles when both are set.
                    # Drop url once proxied tiles exist — otherwise TileJSON relative paths break loads.
                    if source["tiles"]:
                        source.pop("url", None)
                else:
                    url = source.get("url")
                    if isinstance(url, str) and is_arcgis_host(url):
                        source["url"] = tilejson_proxy_url(url, base_url=base_url)

        for value in obj.values():
            _rewrite_obj(value, base_url=base_url)
    elif isinstance(obj, list):
        for item in obj:
            _rewrite_obj(item, base_url=base_url)


def resolve_vector_tile_url(template: str, z: int, x: int, y: int) -> str:
    """Expand {z}/{x}/{y} placeholders (ArcGIS vector tiles use z/y/x order in templates)."""
    clean = validate_arcgis_url(template)
    return clean.replace("{z}", str(z)).replace("{y}", str(y)).replace("{x}", str(x))


def resolve_glyph_url(template: str, fontstack: str, range_id: str) -> str:
    clean = validate_arcgis_url(template)
    return clean.replace("{fontstack}", fontstack).replace("{range}", range_id)


_RES_SPEC_RE = re.compile(r"^(.+?)(@\d+x)?\.(json|png)$")


def resolve_sprite_resource(spec: str) -> str:
    """Parse /api/arcgis/res/<spec> into upstream ArcGIS sprite asset URL."""
    match = _RES_SPEC_RE.match(spec)
    if not match:
        raise ValueError("Invalid sprite resource path")
    enc, retina, ext = match.group(1), match.group(2) or "", match.group(3)
    base = validate_arcgis_url(decode_upstream(enc))
    return f"{base}{retina}.{ext}"


def arcgis_upstream_headers() -> dict[str, str]:
    return {
        "User-Agent": "scepmaps/1.0",
        "Accept": "*/*",
        "Cache-Control": "max-age=3600",
    }
