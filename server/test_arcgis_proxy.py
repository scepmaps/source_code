"""Unit tests for ArcGIS style URL rewriting (no rasterio / Flask required)."""

import json

from arcgis_proxy import (
    decode_upstream,
    encode_upstream,
    is_arcgis_host,
    resolve_glyph_url,
    resolve_sprite_resource,
    resolve_vector_tile_url,
    rewrite_arcgis_style,
    rewrite_tilejson,
    strip_token_param,
)


def test_strip_token_param():
    url = "https://basemaps.arcgis.com/tile/{z}/{y}/{x}?token=SECRET&foo=bar"
    assert strip_token_param(url) == "https://basemaps.arcgis.com/tile/{z}/{y}/{x}?foo=bar"


def test_rewrite_style_removes_tilejson_url_when_tiles_present():
    style = {
        "version": 8,
        "sources": {
            "esri": {
                "type": "vector",
                "tiles": [
                    "https://basemaps-api.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf?token=LEAKED"
                ],
                "url": "https://basemaps-api.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer",
            }
        },
    }
    out = rewrite_arcgis_style(style)
    assert "url" not in out["sources"]["esri"]
    assert out["sources"]["esri"]["tiles"][0].startswith("/tiles/arcgis/vector/")


def test_rewrite_tilejson_relative_paths():
    tilejson = {"tiles": ["tile/{z}/{y}/{x}.pbf"], "maxzoom": 22}
    base = "https://basemaps-api.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer"
    out = rewrite_tilejson(tilejson, base)
    assert out["tiles"][0].startswith("/tiles/arcgis/vector/")
    assert "token=" not in json.dumps(out)


def test_rewrite_style_removes_token_from_tiles_sprite_glyphs():
    style = {
        "version": 8,
        "sprite": "https://basemaps.arcgis.com/arcgis/rest/services/World_Ocean_Base/VectorTileServer/resources/sprites/sprite",
        "glyphs": "https://basemaps.arcgis.com/arcgis/rest/services/World_Ocean_Base/VectorTileServer/resources/fonts/{fontstack}/{range}.pbf",
        "sources": {
            "esri": {
                "type": "vector",
                "tiles": [
                    "https://basemaps.arcgis.com/arcgis/rest/services/World_Ocean_Base/VectorTileServer/tile/{z}/{y}/{x}?token=LEAKED"
                ],
            }
        },
    }
    out = rewrite_arcgis_style(style)
    blob = json.dumps(out)
    assert "LEAKED" not in blob
    assert "token=" not in blob
    assert out["sources"]["esri"]["tiles"][0].startswith("/tiles/arcgis/vector/")
    assert out["sprite"].startswith("/api/arcgis/res/")
    assert out["glyphs"].startswith("/api/arcgis/glyphs/")


def test_encode_decode_roundtrip():
    url = "https://basemaps.arcgis.com/arcgis/rest/services/X/VectorTileServer/tile/{z}/{y}/{x}"
    enc = encode_upstream(url)
    assert decode_upstream(enc) == url


def test_resolve_vector_tile_url():
    template = "https://basemaps.arcgis.com/arcgis/rest/services/X/VectorTileServer/tile/{z}/{y}/{x}"
    assert (
        resolve_vector_tile_url(template, 5, 10, 12)
        == "https://basemaps.arcgis.com/arcgis/rest/services/X/VectorTileServer/tile/5/12/10"
    )


def test_resolve_sprite_resource():
    base = "https://basemaps.arcgis.com/arcgis/rest/services/X/VectorTileServer/resources/sprites/sprite"
    enc = encode_upstream(base)
    assert (
        resolve_sprite_resource(f"{enc}.json")
        == base + ".json"
    )
    assert (
        resolve_sprite_resource(f"{enc}@2x.png")
        == base + "@2x.png"
    )


def test_resolve_glyph_url():
    template = "https://basemaps.arcgis.com/arcgis/rest/services/X/VectorTileServer/resources/fonts/{fontstack}/{range}.pbf"
    got = resolve_glyph_url(template, "Open Sans Regular", "0-255")
    assert got.endswith("/fonts/Open Sans Regular/0-255.pbf")


def test_is_arcgis_host():
    assert is_arcgis_host("https://basemaps.arcgis.com/foo")
    assert not is_arcgis_host("https://example.com/foo")
