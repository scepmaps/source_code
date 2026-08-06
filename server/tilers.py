import io
import math
import os
import random
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from PIL import Image

# Load source_code/server/.env explicitly
load_dotenv(dotenv_path=Path(__file__).with_name(".env"))


OPENAIP_KEY = os.getenv("OPENAIP_KEY")
ARCGIS_API_KEY = os.getenv("ARCGIS_API_KEY")
TILE_SIZE = 256

# Optional but recommended: identify your app politely
HEADERS = {
    "User-Agent": os.getenv("TILE_USER_AGENT", "slippy-to-geotiff/0.1 (contact: you@example.com)"),
    "Referer": os.getenv("TILE_REFERER", "https://data.shom.fr/"),
}

# These are simple, single-URL templates (still fine for the Leaflet UI)
# Build ESRI URL with optional API key
_esri_url = "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
if ARCGIS_API_KEY:
    _esri_url += "?token=" + ARCGIS_API_KEY

# Build Topo URL - using new static-map-tiles-api (arcgis/outdoor)
# For server-side export, use direct URL with API key (safe since server-side)
if ARCGIS_API_KEY:
    _topo_url = f"https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/outdoor/static/tile/{{z}}/{{y}}/{{x}}?token={ARCGIS_API_KEY}"
else:
    _topo_url = "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=arcgis/outdoor"

# Build Navigation URL - using new static-map-tiles-api
if ARCGIS_API_KEY:
    _navigation_url = f"https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/navigation/static/tile/{{z}}/{{y}}/{{x}}?token={ARCGIS_API_KEY}"
else:
    _navigation_url = "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=arcgis/navigation"

# Build Night URL - using new static-map-tiles-api
if ARCGIS_API_KEY:
    _night_url = f"https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/streets-night/static/tile/{{z}}/{{y}}/{{x}}?token={ARCGIS_API_KEY}"
else:
    _night_url = "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=arcgis/streets-night"

# Build Ocean (Navigation Dark) URL - using new static-map-tiles-api
# Ocean uses Open Basemaps Navigation Dark style
# Note: ArcGIS static-map-tiles-api uses {z}/{y}/{x} format (row/column)
if ARCGIS_API_KEY:
    _ocean_url = f"https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/open/navigation-dark/static/tile/{{z}}/{{y}}/{{x}}?token={ARCGIS_API_KEY}"
else:
    # Backend proxy receives Leaflet format {z}/{x}/{y} and swaps to ArcGIS format {z}/{y}/{x}
    _ocean_url = "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=open/navigation-dark"

LAYER_URLS = {
    "osm": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    # OSM data, dark palette (CARTO Dark Matter) — distinct from the ArcGIS "night" style.
    "dark": "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    "esri": _esri_url,
    "topo": _topo_url,
    "navigation": _navigation_url,
    "night": _night_url,
    "ocean": _ocean_url,
    # Prefer the 3857 WMTS endpoint; client proxy route also available at /tiles/shom
    "shom": os.getenv(
        "SHOM_TEMPLATE",
        "https://services.data.shom.fr/clevisu/wmts?layer=RASTER_MARINE_3857_WMTS&style=normal&tilematrixset=3857&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/png&TileMatrix={z}&TileCol={x}&TileRow={y}",
    ),
    "ukho": "http://127.0.0.1:5001/tiles/ukho/{z}/{x}/{y}.png",
    "gbsouth": "http://127.0.0.1:5001/tiles/gbsouth/{z}/{x}/{y}.png",  # GB South via backend proxy
    "openseamap": "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
}

# For the server-side exporter, use candidates so we can pick based on availability/keys
LAYER_CANDIDATES = {
    "osm": [
        "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
        "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
    ],
    "dark": [
        "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    ],
    "esri": [
        # Use API key if available for better rate limits and premium services
        (
            f"https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{{z}}/{{y}}/{{x}}?token={ARCGIS_API_KEY}"
            if ARCGIS_API_KEY
            else None
        ),
        # Fallback to public endpoint
        "https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    ],
    "topo": [
        # Use new static-map-tiles-api with API key (server-side, key is safe)
        (
            f"https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/outdoor/static/tile/{{z}}/{{y}}/{{x}}?token={ARCGIS_API_KEY}"
            if ARCGIS_API_KEY
            else None
        ),
        # Fallback to backend proxy
        "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=arcgis/outdoor",
    ],
    "navigation": [
        # Use new static-map-tiles-api with API key (server-side, key is safe)
        (
            f"https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/navigation/static/tile/{{z}}/{{y}}/{{x}}?token={ARCGIS_API_KEY}"
            if ARCGIS_API_KEY
            else None
        ),
        # Fallback to backend proxy
        "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=arcgis/navigation",
    ],
    "night": [
        # Use new static-map-tiles-api with API key (server-side, key is safe)
        (
            f"https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/streets-night/static/tile/{{z}}/{{y}}/{{x}}?token={ARCGIS_API_KEY}"
            if ARCGIS_API_KEY
            else None
        ),
        # Fallback to backend proxy
        "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=arcgis/streets-night",
    ],
    "ocean": [
        # Use new static-map-tiles-api with API key for Open Basemaps Navigation Dark (server-side, key is safe)
        (
            f"https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/open/navigation-dark/static/tile/{{z}}/{{y}}/{{x}}?token={ARCGIS_API_KEY}"
            if ARCGIS_API_KEY
            else None
        ),
        # Fallback to backend proxy
        "http://127.0.0.1:5001/tiles/arcgis/{z}/{x}/{y}.png?style=open/navigation-dark",
    ],
    "shom": [
        # Backend proxy is the most reliable (adds Referer header)
        "http://127.0.0.1:5001/tiles/shom/{z}/{x}/{y}.png",
        # Fallback to direct WMTS (requires Referer header, set above)
        os.getenv(
            "SHOM_TEMPLATE",
            "https://services.data.shom.fr/clevisu/wmts?layer=RASTER_MARINE_3857_WMTS&style=normal&tilematrixset=3857&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/png&TileMatrix={z}&TileCol={x}&TileRow={y}",
        ),
    ],
    "ukho": [
        "http://127.0.0.1:5001/tiles/ukho/{z}/{x}/{y}.png",
    ],
    "gbsouth": [
        # Use backend proxy to access mounted tiles
        "http://127.0.0.1:5001/tiles/gbsouth/{z}/{x}/{y}.png",
    ],
    "openseamap": [
        "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png",
    ],
    "openaip": [
        # Prefer backend proxy if available
        "http://127.0.0.1:5001/tiles/openaip/{z}/{x}/{y}.png" if OPENAIP_KEY else None,
        # Fallback to direct only when key exists and no proxy
        (
            f"https://{{s}}.api.tiles.openaip.net/api/data/openaip/{{z}}/{{x}}/{{y}}.png?apiKey={OPENAIP_KEY}"
            if OPENAIP_KEY
            else None
        ),
    ],
}


# Helper: pick a usable URL for a given logical layer
def choose_url(layer_key: str) -> str:
    urls = [u for u in LAYER_CANDIDATES.get(layer_key, []) if u]  # skip None
    if not urls:
        raise RuntimeError(
            f"No provider URL available for layer '{layer_key}'. " f"Check API keys or configure LAYER_CANDIDATES."
        )
    return random.choice(urls)


SUBS = ["a", "b", "c"]


# Web Mercator helpers
def lonlat_to_pixel(lon, lat, z):
    siny = math.sin(lat * math.pi / 180.0)
    siny = min(max(siny, -0.9999), 0.9999)
    scale = TILE_SIZE * (2**z)
    x = (lon + 180.0) / 360.0 * scale
    y = (0.5 - math.log((1 + siny) / (1 - siny)) / (4 * math.pi)) * scale
    return x, y


def pixel_to_lonlat(x, y, z):
    scale = TILE_SIZE * (2**z)
    lon = x / scale * 360.0 - 180.0
    n = math.pi - 2.0 * math.pi * y / scale
    lat = (180.0 / math.pi) * math.atan(math.sinh(n))
    return lon, lat


def pixel_bounds_for_bbox(bbox, z):
    w, s, e, n = bbox
    px_min = lonlat_to_pixel(w, n, z)  # top-left
    px_max = lonlat_to_pixel(e, s, z)  # bottom-right
    left = min(px_min[0], px_max[0])
    top = min(px_min[1], px_max[1])
    right = max(px_min[0], px_max[0])
    bottom = max(px_min[1], px_max[1])
    return left, top, right, bottom


def tile_range_for_pixels(left, top, right, bottom):
    tx_min = int(math.floor(left / TILE_SIZE))
    ty_min = int(math.floor(top / TILE_SIZE))
    tx_max = int(math.floor((right - 1) / TILE_SIZE))
    ty_max = int(math.floor((bottom - 1) / TILE_SIZE))
    return tx_min, ty_min, tx_max, ty_max


def _http_get(url, timeout=12, retries=3, backoff=0.5):
    last = None
    for i in range(retries):
        try:
            r = requests.get(url, timeout=timeout, headers=HEADERS)
            if r.status_code == 200:
                return r.content
            if r.status_code in (429, 503, 403):
                time.sleep(backoff * (2**i))
                continue
            r.raise_for_status()
            return r.content
        except Exception as e:
            last = e
            time.sleep(backoff * (2**i))
    if last:
        raise last


def fetch_tile(z, x, y, template, timeout=12):
    """
    Fetch a tile image. Coordinates are in Leaflet format (z, x, y) where:
    - z: zoom level
    - x: tile column (horizontal, 0 to 2^z-1)
    - y: tile row (vertical, 0 to 2^z-1)

    Templates can be in two formats:
    - Leaflet: {z}/{x}/{y} (column/row)
    - ArcGIS: {z}/{y}/{x} (row/column)

    The replacement order doesn't matter since {x}, {y}, {z} are unique strings.
    However, we need to ensure the correct values go to the correct positions.
    For ArcGIS {z}/{y}/{x}: {y} gets row (y param), {x} gets column (x param)
    For Leaflet {z}/{x}/{y}: {x} gets column (x param), {y} gets row (y param)
    """
    url = template
    if "{s}" in url:
        url = url.replace("{s}", SUBS[(x + y) % len(SUBS)])

    # Simple replacement - order doesn't matter since {x}, {y}, {z} are unique
    # For ArcGIS templates with {z}/{y}/{x}, this correctly maps:
    #   {y} → y (row), {x} → x (column)
    # For Leaflet templates with {z}/{x}/{y}, this correctly maps:
    #   {x} → x (column), {y} → y (row)
    url = url.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))

    raw = _http_get(url, timeout=timeout)
    return Image.open(io.BytesIO(raw)).convert("RGBA")
