import hashlib
import io
import logging
import math
import os
import random
import sqlite3
import threading
import time
import zipfile
from pathlib import Path
from urllib.parse import urlencode

import numpy as np

# Raster IO / reprojection
import rasterio
import requests
from auth import extract_bearer_token, hash_password, mint_token_for_user, verify_password, verify_token
from db import (
    count_exports_since,
    count_user_kml,
    create_user,
    create_user_kml,
    delete_user,
    delete_user_kml,
    ensure_default_admin,
    get_all_export_stats,
    get_user_by_email,
    get_user_by_id,
    get_user_export_stats,
    get_user_kml,
    init_db,
    list_user_kml,
    list_users,
    MAX_KML_BYTES,
    MAX_KML_PER_USER,
    MAX_KML_STORAGE_BYTES,
    release_export_quota,
    reserve_export_quota,
    sum_user_kml_bytes,
    update_user,
    update_user_kml,
)
from dotenv import load_dotenv

# Activity emitter — stdout/syslog transport (no whatchman imports)
import activity

# Our modules
from arcgis_proxy import (
    arcgis_upstream_headers,
    decode_upstream,
    resolve_glyph_url,
    resolve_sprite_resource,
    resolve_vector_tile_url,
    rewrite_arcgis_style,
    rewrite_tile_url,
    rewrite_tilejson,
    validate_arcgis_url,
)
from exporter import export_geotiff  # server-side tiles → mosaic → GeoTIFF
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from headless import render_headless_map  # Playwright path (browser-rendered bitmap)
from kml_geojson import prepare_kml_export_layers
from PIL import Image, ImageDraw, ImageFont
from rasterio.io import MemoryFile
from rasterio.transform import Affine
from rasterio.warp import Resampling, calculate_default_transform, reproject
from utils import bbox_4326_to_3857
from werkzeug.middleware.proxy_fix import ProxyFix

# Load source_code/server/.env to keep secrets out of the repo root
load_dotenv(dotenv_path=Path(__file__).with_name(".env"))

# Initialize DB and default admin
init_db()
ensure_default_admin(
    os.getenv("ADMIN_EMAIL", "admin@example.com"), hash_password(os.getenv("ADMIN_PASSWORD", "admin123"))
)

app = Flask(__name__, static_folder="../frontend", static_url_path="")
logger = logging.getLogger(__name__)

# Traefik terminates TLS and nginx forwards X-Forwarded-Proto. Without ProxyFix,
# request.host_url stays http://… and MapLibre drops JWT on rewritten ArcGIS style URLs.
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

# Cap export raster dimensions (per side). Also used to bound headless device_scale_factor.
try:
    MAX_EXPORT_SIZE = max(256, int(os.getenv("MAX_EXPORT_SIZE", "4096")))
except ValueError:
    MAX_EXPORT_SIZE = 4096
try:
    MAX_EXPORT_DEVICE_SCALE = max(1.0, float(os.getenv("MAX_EXPORT_DEVICE_SCALE", "4")))
except ValueError:
    MAX_EXPORT_DEVICE_SCALE = 4.0

_PROD_CORS_ORIGINS = (
    "https://app.scep.city",
    "https://scepmaps.scep.city",
    "https://pamerkuf.scep.city",
)
_DEV_CORS_ORIGINS = (
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:5001",
    "http://127.0.0.1:5001",
    "http://localhost:8088",
    "http://127.0.0.1:8088",
)
_CORS_PLACEHOLDERS = frozenset({"https://yourdomain.com", "https://www.yourdomain.com"})


def _is_production() -> bool:
    return os.getenv("FLASK_ENV", "production").strip().lower() == "production"


def _parse_cors_origins() -> list[str]:
    """Use CORS_ORIGINS from env; never allow '*' in production."""
    raw = os.getenv("CORS_ORIGINS", "").strip()
    defaults = list(_PROD_CORS_ORIGINS if _is_production() else _DEV_CORS_ORIGINS)
    if not raw:
        return defaults
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if "*" in parts:
        if _is_production():
            logger.warning("CORS_ORIGINS contains '*'; refusing wildcard in production")
            return list(_PROD_CORS_ORIGINS)
        return list(_DEV_CORS_ORIGINS)
    cleaned = [p for p in parts if p not in _CORS_PLACEHOLDERS]
    return cleaned or defaults


CORS(app, origins=_parse_cors_origins(), supports_credentials=False)


def _http_500(public: str = "Internal server error", *, exc: BaseException | None = None):
    """Return a client-safe 500; log full exception server-side."""
    if exc is not None:
        logger.exception("%s", public)
    if _is_production() or exc is None:
        return (public, 500)
    return (f"{public}: {exc}", 500)


def _json_500(public: str = "Internal server error", *, exc: BaseException | None = None):
    if exc is not None:
        logger.exception("%s", public)
    msg = public if (_is_production() or exc is None) else f"{public}: {exc}"
    return jsonify({"error": msg}), 500


def _parse_export_dimensions(data) -> tuple[int, int]:
    """Parse and enforce width/height caps for /export and /export_headless."""
    try:
        width = int(data["width"])
        height = int(data["height"])
    except (KeyError, TypeError, ValueError) as e:
        raise ValueError("width and height must be positive integers") from e
    if width <= 0 or height <= 0:
        raise ValueError("width and height must be positive integers")
    if width > MAX_EXPORT_SIZE or height > MAX_EXPORT_SIZE:
        raise ValueError(
            f"Export dimensions {width}x{height} exceed limit of {MAX_EXPORT_SIZE}px per side"
        )
    return width, height


@app.before_request
def _activity_start():
    activity.on_request_start()


@app.after_request
def _security_headers(response):
    """Hardening that previously lived only in unused app_prod.py."""
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-XSS-Protection", "1; mode=block")
    response.headers.setdefault(
        "Content-Security-Policy",
        (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://unpkg.com; "
            "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; "
            "img-src 'self' data: https: blob:; "
            "font-src 'self' data: https://fonts.gstatic.com; "
            "connect-src 'self'; "
            "worker-src 'self' blob:; "
            "child-src 'self' blob:; "
            "frame-ancestors 'none';"
        ),
    )
    if _is_production():
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )
    return response


@app.after_request
def _activity_end(response):
    return activity.on_request_end(response)


@app.errorhandler(500)
def _handle_500(error):
    logger.exception("Unhandled server error: %s", error)
    return jsonify({"error": "Internal server error"}), 500


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/login.html")
def serve_login_page():
    return app.send_static_file("login.html")


@app.route("/admin.html")
def serve_admin_page():
    return app.send_static_file("admin.html")


@app.route("/data/<path:filename>")
def serve_density_data(filename):
    """Serve population density data files"""
    # Security check - only allow specific density files
    allowed_files = ["density_lad.json", "density_msoa.json", "density_oa.json"]
    if filename not in allowed_files:
        return ({"error": "Not found"}, 404)
    return app.send_static_file(f"data/{filename}")


@app.route("/health")
def health():
    return {"status": "ok"}


def _download_name(out_crs: str, zoom: int, filename: str | None) -> str:
    # Convert to inverse zoom level: z1 = max zoom (20), higher numbers = more zoomed out
    inverse_zoom = 21 - zoom
    ts = time.strftime("%Y%m%d_%H%M%S", time.gmtime())

    if filename:
        # sanitize a bit
        safe = "".join(c for c in filename if c.isalnum() or c in (" ", "_", "-", ".")).strip()
        if not safe:
            safe = None
    else:
        safe = None

    if safe:
        return f"z{inverse_zoom}_{safe}_{ts}.tif"
    else:
        return f"z{inverse_zoom}_export_{out_crs.replace(':','_')}_{ts}.tif"


def _resolve_export_kml_layers(user: dict, data: dict) -> list:
    """Load active user KML overlays requested for TIF export."""
    raw_ids = data.get("kmlIds") or data.get("kml_ids") or []
    if not isinstance(raw_ids, list) or not raw_ids:
        return []
    user_id = int(user["id"])
    layers = []
    seen = set()
    for raw in raw_ids[:MAX_KML_PER_USER]:
        try:
            kml_id = int(raw)
        except (TypeError, ValueError):
            continue
        if kml_id in seen:
            continue
        seen.add(kml_id)
        row = get_user_kml(user_id, kml_id)
        if not row or not row.get("content"):
            continue
        layers.append(
            {
                "name": row.get("name") or f"KML #{kml_id}",
                "content": row["content"],
                "color": row.get("color") or "#4de2ff",
                "opacity": row.get("opacity", 0.65),
            }
        )
    return prepare_kml_export_layers(layers)


def _export_headless_geotiff_bytes(
    bbox,
    zoom: int,
    width: int,
    height: int,
    base: str,
    overlays: dict,
    out_crs: str = "EPSG:4326",
    show_attribution: bool = True,
    kml_layers=None,
):
    """Shared headless export pipeline used by /export_headless and HGT map-underlay TIFF."""
    mosaic, exact_bbox = render_headless_map(
        bbox,
        zoom,
        width,
        height,
        base,
        overlays,
        show_attribution=show_attribution,
        kml_layers=kml_layers,
    )

    xmin, ymin, xmax, ymax = bbox_4326_to_3857(exact_bbox)
    src_w, src_h = mosaic.size
    xres = (xmax - xmin) / src_w
    yres = (ymax - ymin) / src_h
    transform3857 = Affine(xres, 0, xmin, 0, -yres, ymax)

    arr = np.array(mosaic)  # H,W,4 (native size)
    bands = [arr[:, :, 0], arr[:, :, 1], arr[:, :, 2], arr[:, :, 3]]

    with MemoryFile() as mem:
        with mem.open(
            driver="GTiff",
            width=src_w,
            height=src_h,
            count=4,
            dtype=bands[0].dtype,
            crs="EPSG:3857",
            transform=transform3857,
        ) as src:
            for i in range(4):
                src.write(bands[i], i + 1)

        with mem.open() as src:
            if out_crs == "EPSG:3857" and src.width == width and src.height == height:
                return mem.read()

            left, bottom, right, top = rasterio.warp.transform_bounds(src.crs, out_crs, *src.bounds)
            dst_width, dst_height = max(1, int(width)), max(1, int(height))
            xres = (right - left) / dst_width if dst_width else 0
            yres = (top - bottom) / dst_height if dst_height else 0
            dst_transform = Affine(xres, 0, left, 0, -yres, top)
            with MemoryFile() as mem2:
                with mem2.open(
                    driver="GTiff",
                    width=dst_width,
                    height=dst_height,
                    count=4,
                    dtype=src.dtypes[0],
                    crs=out_crs,
                    transform=dst_transform,
                ) as dst:
                    for i in range(1, 5):
                        reproject(
                            source=rasterio.band(src, i),
                            destination=rasterio.band(dst, i),
                            src_transform=src.transform,
                            src_crs=src.crs,
                            dst_transform=dst.transform,
                            dst_crs=dst.crs,
                            resampling=Resampling.lanczos,
                        )
                return mem2.read()


@app.route("/export", methods=["POST"])
def export_endpoint():
    """
    Server-side export that fetches tiles with requests (good for Esri, WMS, self-hosted providers).
    """
    import logging

    logger = logging.getLogger(__name__)
    export_log_id = None

    try:
        data = request.get_json(force=True)
        bbox = data["bbox"]  # [w,s,e,n] in EPSG:4326
        zoom = int(data["zoom"])
        width, height = _parse_export_dimensions(data)
        base = data.get("base", "esri")  # typically 'esri' here
        overlays = data.get("overlays", {})
        system = data.get("system")
        quality = data.get("quality")
        out_crs = data.get("crs") or "EPSG:4326"
        filename = data.get("filename")

        logger.info(f"[Export] ========== Tile-based Export Started ==========")
        logger.info(
            f"[Export] Request Parameters: bbox={bbox}, zoom={zoom}, width={width}, height={height}, base={base}, overlays={overlays}, system={system}, quality={quality}, out_crs={out_crs}, filename={filename}"
        )

        user, export_log_id = _require_auth_with_quota(request, base, overlays)
        logger.info(f"[Export] User authenticated: user_id={user.get('id')}, email={user.get('email')}")

        # Activity — request params + resolved identity (before heavy work starts)
        activity.enrich(
            user=user,
            export_type="tile",
            base=base,
            overlays=overlays,
            bbox=bbox,
            bbox_area_km2=activity.bbox_area_km2(bbox),
            bbox_center=activity.bbox_center(bbox),
            zoom=zoom,
            width=width,
            height=height,
            crs=out_crs,
            system=system,
            quality=quality,
            filename=filename,
        )

        logger.info(f"[Export] Calling export_geotiff()...")
        result_bytes = export_geotiff(bbox, zoom, width, height, base, overlays, out_crs, system)
        logger.info(f"[Export] export_geotiff() completed: output_size={len(result_bytes)} bytes")

        # Activity — output size (only reachable on success)
        activity.enrich(bytes_produced=len(result_bytes))

        buf = io.BytesIO(result_bytes)
        buf.seek(0)

        logger.info(f"[Export] ========== Tile-based Export Completed Successfully ==========")
        return send_file(
            buf,
            mimetype="image/tiff",
            as_attachment=True,
            download_name=_download_name(out_crs, zoom, filename),
        )
    except PermissionError as pe:
        release_export_quota(export_log_id)
        message = str(pe) or "Unauthorized"
        status = 401 if message == "Unauthorized" else 403
        return (message, status)
    except ValueError as ve:
        release_export_quota(export_log_id)
        return (str(ve), 400)
    except Exception as e:
        release_export_quota(export_log_id)
        logger.error(f"[Export] ========== Tile-based Export Failed ==========")
        logger.error(f"[Export] Error: {e}", exc_info=True)
        activity.enrich(error_message=str(e)[:300])
        return _http_500("Export failed", exc=e)


@app.route("/export_headless", methods=["POST"])
def export_headless():
    """
    Playwright-based export that renders Leaflet in headless Chromium, screenshots the map,
    then georeferences the bitmap and (optionally) reprojects to out_crs.
    Use this for OSM base to avoid backend scraping OSM tiles.
    """
    import logging

    logger = logging.getLogger(__name__)
    export_log_id = None
    user = None
    out_crs = "EPSG:4326"
    zoom = 0
    filename = None

    try:
        data = request.get_json(force=True)
        bbox = data["bbox"]  # [w,s,e,n] in EPSG:4326
        zoom = int(data["zoom"])
        width, height = _parse_export_dimensions(data)
        base = data.get("base", "osm")  # 'osm' or 'esri'
        overlays = data.get("overlays", {})
        system = data.get("system")
        quality = data.get("quality")
        out_crs = data.get("crs") or "EPSG:4326"
        filename = data.get("filename")
        show_attribution = data.get("showAttribution", True)

        logger.info(f"[Export] ========== Headless Export Started ==========")
        logger.info(
            f"[Export] Request Parameters: bbox={bbox}, zoom={zoom}, width={width}, height={height}, base={base}, overlays={overlays}, system={system}, quality={quality}, out_crs={out_crs}, filename={filename}, show_attribution={show_attribution}"
        )

        user, export_log_id = _require_auth_with_quota(request, base, overlays)
        logger.info(f"[Export] User authenticated: user_id={user.get('id')}, email={user.get('email')}")

        kml_layers = _resolve_export_kml_layers(user, data)
        if kml_layers:
            logger.info(f"[Export] Including {len(kml_layers)} KML overlay(s) in headless render")

        # Activity — request params + resolved identity
        activity.enrich(
            user=user,
            export_type="headless",
            base=base,
            overlays=overlays,
            bbox=bbox,
            bbox_area_km2=activity.bbox_area_km2(bbox),
            bbox_center=activity.bbox_center(bbox),
            zoom=zoom,
            width=width,
            height=height,
            crs=out_crs,
            system=system,
            quality=quality,
            filename=filename,
            show_attribution=show_attribution,
            kml_count=len(kml_layers),
        )

        logger.info(f"[Export] Step 1-3: Rendering + georeferencing via shared headless pipeline")
        out_bytes = _export_headless_geotiff_bytes(
            bbox=bbox,
            zoom=zoom,
            width=width,
            height=height,
            base=base,
            overlays=overlays,
            out_crs=out_crs,
            show_attribution=show_attribution,
            kml_layers=kml_layers,
        )
    except PermissionError as pe:
        release_export_quota(export_log_id)
        message = str(pe) or "Unauthorized"
        status = 401 if message == "Unauthorized" else 403
        return (message, status)
    except ValueError as ve:
        release_export_quota(export_log_id)
        return (str(ve), 400)
    except Exception as e:
        release_export_quota(export_log_id)
        logger.error(f"[Export] Error in export_headless preparation: {e}", exc_info=True)
        activity.enrich(error_message=str(e)[:300])
        return _http_500("Export preparation failed", exc=e)

    try:
        # Activity — output size (only reachable on success)
        activity.enrich(bytes_produced=len(out_bytes))

        result = send_file(
            io.BytesIO(out_bytes),
            mimetype="image/tiff",
            as_attachment=True,
            download_name=_download_name(out_crs, zoom, filename),
        )
        logger.info(f"[Export] ========== Headless Export Completed Successfully ==========")
        return result
    except Exception as e:
        release_export_quota(export_log_id)
        logger.error(f"[Export] ========== Headless Export Failed ==========")
        logger.error(f"[Export] Error: {e}", exc_info=True)
        activity.enrich(error_message=str(e)[:300])
        return _http_500("Export processing failed", exc=e)


def _sanitize_export_filename(raw: str | None, fallback: str) -> str:
    if not raw:
        return fallback
    safe = "".join(c for c in str(raw) if c.isalnum() or c in (" ", "_", "-", ".")).strip()
    return safe or fallback


def _hgt_tile_name(lat_sw: int, lon_sw: int) -> str:
    lat_prefix = "N" if lat_sw >= 0 else "S"
    lon_prefix = "E" if lon_sw >= 0 else "W"
    return f"{lat_prefix}{abs(lat_sw):02d}{lon_prefix}{abs(lon_sw):03d}.hgt"


def _hgt_tiles_for_bbox(bbox):
    west, south, east, north = bbox
    eps = 1e-9
    min_lon = int(math.floor(west))
    max_lon = int(math.ceil(east - eps)) - 1
    min_lat = int(math.floor(south))
    max_lat = int(math.ceil(north - eps)) - 1
    tiles = []
    for lat_sw in range(min_lat, max_lat + 1):
        for lon_sw in range(min_lon, max_lon + 1):
            tiles.append(_hgt_tile_name(lat_sw, lon_sw))
    return tiles


_HGT_WATER_TILE_SIZE = 1201  # SRTMGL3 samples per side
_HGT_WATER_TILE_BYTES = np.zeros((_HGT_WATER_TILE_SIZE, _HGT_WATER_TILE_SIZE), dtype=">i2").tobytes()
_HGT_MISSING_ALLOWLIST_CACHE = None
_HGT_EXPORT_MAX_TILES = 1600
_HGT_TIFF_PIXELS_PER_TILE = 64


def _parse_hgt_tile_sw(tile_name: str):
    if not isinstance(tile_name, str) or len(tile_name) < 11:
        raise ValueError(f"Invalid HGT tile name: {tile_name}")
    core = tile_name[:-4] if tile_name.lower().endswith(".hgt") else tile_name
    if len(core) != 7:
        raise ValueError(f"Invalid HGT tile name: {tile_name}")
    lat_prefix = core[0].upper()
    lon_prefix = core[3].upper()
    lat = int(core[1:3])
    lon = int(core[4:7])
    lat_sw = lat if lat_prefix == "N" else -lat
    lon_sw = lon if lon_prefix == "E" else -lon
    return lat_sw, lon_sw


def _hgt_tile_extent_from_requested_tiles(requested_tiles):
    sw_coords = [_parse_hgt_tile_sw(t) for t in requested_tiles]
    min_lat = min(lat for lat, _ in sw_coords)
    max_lat = max(lat for lat, _ in sw_coords)
    min_lon = min(lon for _, lon in sw_coords)
    max_lon = max(lon for _, lon in sw_coords)
    west = float(min_lon)
    south = float(min_lat)
    east = float(max_lon + 1)
    north = float(max_lat + 1)
    tiles_w = max_lon - min_lon + 1
    tiles_h = max_lat - min_lat + 1
    return (west, south, east, north, min_lon, max_lon, min_lat, max_lat, tiles_w, tiles_h)


def _build_hgt_overlay_rgba_for_grid(requested_tiles, present_tile_names, synthetic_water_tile_names, width, height):
    west, south, east, north, min_lon, max_lon, min_lat, max_lat, _, _ = _hgt_tile_extent_from_requested_tiles(
        requested_tiles
    )
    transform = rasterio.transform.from_bounds(west, south, east, north, width, height)
    lon_span = east - west
    lat_span = north - south

    def lon_to_col(lon):
        return int(round(((lon - west) / lon_span) * width))

    def lat_to_row(lat):
        return int(round(((north - lat) / lat_span) * height))

    rgba = np.zeros((4, height, width), dtype=np.uint8)

    fill_alpha = 120
    grid_alpha = 190
    for tile_name in requested_tiles:
        lat_sw, lon_sw = _parse_hgt_tile_sw(tile_name)
        x0 = max(0, min(width, lon_to_col(lon_sw)))
        x1 = max(0, min(width, lon_to_col(lon_sw + 1)))
        y0 = max(0, min(height, lat_to_row(lat_sw + 1)))
        y1 = max(0, min(height, lat_to_row(lat_sw)))
        if y1 <= y0 or x1 <= x0:
            continue

        if tile_name in present_tile_names:
            r, g, b = 34, 197, 94
        elif tile_name in synthetic_water_tile_names:
            r, g, b = 43, 121, 255
        else:
            continue

        rgba[0, y0:y1, x0:x1] = r
        rgba[1, y0:y1, x0:x1] = g
        rgba[2, y0:y1, x0:x1] = b
        rgba[3, y0:y1, x0:x1] = fill_alpha

    # Draw grid lines at every integer lon/lat boundary.
    for lon in range(int(min_lon), int(max_lon) + 2):
        col = max(0, min(width - 1, lon_to_col(float(lon))))
        rgba[0, :, col] = 255
        rgba[1, :, col] = 255
        rgba[2, :, col] = 255
        rgba[3, :, col] = grid_alpha
    for lat in range(int(min_lat), int(max_lat) + 2):
        row = max(0, min(height - 1, lat_to_row(float(lat))))
        rgba[0, row, :] = 255
        rgba[1, row, :] = 255
        rgba[2, row, :] = 255
        rgba[3, row, :] = grid_alpha

    return rgba, transform


def _build_hgt_map_with_grid_png_bytes(
    requested_tiles, present_tile_names, synthetic_water_tile_names, base: str, zoom: int, system: str | None
):
    import logging

    logger = logging.getLogger(__name__)
    west, south, east, north, _, _, _, _, tiles_w, tiles_h = _hgt_tile_extent_from_requested_tiles(requested_tiles)
    width = max(256, tiles_w * _HGT_TIFF_PIXELS_PER_TILE)
    height = max(256, tiles_h * _HGT_TIFF_PIXELS_PER_TILE)
    if width > MAX_EXPORT_SIZE or height > MAX_EXPORT_SIZE:
        raise ValueError(
            f"HGT map underlay {width}x{height} exceeds export limit of {MAX_EXPORT_SIZE}px per side "
            f"(reduce selection / tile count)"
        )
    # Avoid OSM fallback here: OSM can return policy-warning tiles for automated bulk export usage.
    # Keep exports on configured providers only.
    allowed_bases = {"dark", "esri", "topo", "navigation", "night", "ocean", "shom", "ukho", "gbsouth"}
    requested_base = str(base or "esri")
    if requested_base not in allowed_bases:
        requested_base = "esri"
    candidate_bases = [requested_base]
    for fallback in ("esri",):
        if fallback not in candidate_bases:
            candidate_bases.append(fallback)

    base_data = None
    h = None
    w = None
    for base_candidate in candidate_bases:
        try:
            map_bytes = _export_headless_geotiff_bytes(
                bbox=[west, south, east, north],
                zoom=int(zoom),
                width=int(width),
                height=int(height),
                base=base_candidate,
                overlays={},
                out_crs="EPSG:4326",
                show_attribution=False,
            )
            with MemoryFile(map_bytes) as mem_map:
                with mem_map.open() as src:
                    data = src.read()
                    if data.shape[0] >= 4:
                        alpha_coverage = float(np.mean(data[3] > 0))
                    else:
                        alpha_coverage = 1.0
                    # If the layer is mostly transparent (e.g. no chart coverage), try fallback basemap.
                    if alpha_coverage > 0.02 or base_candidate == candidate_bases[-1]:
                        base_data = data
                        h = src.height
                        w = src.width
                        break
        except Exception as e:
            logger.warning("[HGT] Headless base layer build failed for base=%s: %s", base_candidate, e)

    if base_data is None:
        raise RuntimeError("Failed to render map underlay for HGT overlay PNG")

    if base_data.shape[0] >= 3:
        base_rgb = base_data[:3].astype(np.float32)
    else:
        base_rgb = np.repeat(base_data[:1], 3, axis=0).astype(np.float32)
    if base_data.shape[0] >= 4:
        base_alpha = base_data[3].astype(np.float32) / 255.0
    else:
        base_alpha = np.ones((base_rgb.shape[1], base_rgb.shape[2]), dtype=np.float32)

    overlay_rgba, _ = _build_hgt_overlay_rgba_for_grid(
        requested_tiles,
        present_tile_names,
        synthetic_water_tile_names,
        w,
        h,
    )
    ov_rgb = overlay_rgba[:3].astype(np.float32)
    ov_alpha = (overlay_rgba[3].astype(np.float32) / 255.0) * 0.85

    out_rgb = base_rgb * (1.0 - ov_alpha[None, :, :]) + ov_rgb * ov_alpha[None, :, :]
    out_alpha = np.maximum(base_alpha, ov_alpha)
    out = np.zeros((4, h, w), dtype=np.uint8)
    out[:3] = np.clip(out_rgb, 0, 255).astype(np.uint8)
    out[3] = np.clip(out_alpha * 255.0, 0, 255).astype(np.uint8)

    # Add bottom legend directly on the TIFF image (without changing raster extent/georeferencing).
    rgba_img = np.transpose(out, (1, 2, 0))
    pil_img = Image.fromarray(rgba_img, mode="RGBA")
    draw = ImageDraw.Draw(pil_img, "RGBA")
    font = ImageFont.load_default()

    pad = 8
    nasa_txt = "NASA SRTM3 HGT real elevation data"
    synth_txt = "Artificial 0 m ocean tile (generated filler)"
    ts_txt = f"Exported UTC: {time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime())}"
    ts_w = int(draw.textlength(ts_txt, font=font))
    # Keep the legend strip small on all exports: fraction of height with hard pixel caps.
    _LEGEND_H_MAX = 38
    _LEGEND_H_MAX_TWO_LINE = 46
    _LEGEND_H_MIN = 22
    # Reserve horizontal space for the timestamp so legend text never runs under it.
    _TS_GAP = 10
    content_max_w = max(80, w - ts_w - 2 * pad - _TS_GAP)

    content_h = max(_LEGEND_H_MIN, min(_LEGEND_H_MAX, int(h * 0.035)))
    sw = max(8, min(14, (content_h - 8) // 2))
    nasa_w = int(draw.textlength(nasa_txt, font=font))
    synth_w = int(draw.textlength(synth_txt, font=font))
    # Second line when the two labels do not fit in the width left of the timestamp column.
    second_line = (pad + sw + 6 + nasa_w + 18 + sw + 6 + synth_w + pad) > content_max_w
    if second_line:
        content_h = min(_LEGEND_H_MAX_TWO_LINE, max(content_h, 34))

    # Dedicated thin row for the date so it never overlaps the green/blue legend lines.
    ts_row_h = 16
    total_legend_h = content_h + ts_row_h

    y0 = max(0, h - total_legend_h)
    draw.rectangle([(0, y0), (w - 1, h - 1)], fill=(0, 0, 0, 165))

    text_y = y0 + max(2, (content_h - 10) // 2 - 4)

    x = pad
    draw.rectangle([(x, y0 + 6), (x + sw, y0 + 6 + sw)], fill=(34, 197, 94, 220))
    x += sw + 6
    draw.text((x, text_y), nasa_txt, fill=(255, 255, 255, 230), font=font)

    x2 = x + nasa_w + 18
    if second_line:
        x2 = pad
        y_second = y0 + max(10, content_h // 2 + 1)
    else:
        y_second = y0 + 6
    draw.rectangle([(x2, y_second), (x2 + sw, y_second + sw)], fill=(43, 121, 255, 220))
    x2 += sw + 6
    draw.text((x2, text_y if not second_line else y_second - 1), synth_txt, fill=(255, 255, 255, 230), font=font)

    # Timestamp: bottom row of the band only (right-aligned), never stacked on legend text.
    ts_x = max(pad, w - ts_w - pad)
    ts_y = y0 + content_h + 2
    draw.text((ts_x, ts_y), ts_txt, fill=(255, 255, 255, 220), font=font)

    png_buf = io.BytesIO()
    pil_img.save(png_buf, format="PNG")
    return png_buf.getvalue()


def _load_hgt_missing_allowlist():
    global _HGT_MISSING_ALLOWLIST_CACHE
    if _HGT_MISSING_ALLOWLIST_CACHE is not None:
        return _HGT_MISSING_ALLOWLIST_CACHE

    # Locate the mounted/non-mounted `data/` directory.
    # - Docker: __file__=/app/server/app.py, data is mounted at /app/server/data
    # - Local/dev: data is at repo root: /repo/data
    server_data_root = Path(__file__).resolve().parent / "data"
    repo_data_root = Path(__file__).resolve().parent.parent.parent / "data"
    data_root = server_data_root if server_data_root.exists() else repo_data_root

    allowlist_path = data_root / "srtmgl3" / "missing_hgt_tiles_s56_n60.txt"
    if not allowlist_path.exists():
        _HGT_MISSING_ALLOWLIST_CACHE = set()
        return _HGT_MISSING_ALLOWLIST_CACHE

    allowed = set()
    with allowlist_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            tile = line.strip()
            if not tile or tile.startswith("#"):
                continue
            if tile.lower().endswith(".hgt"):
                allowed.add(tile)
    _HGT_MISSING_ALLOWLIST_CACHE = allowed
    return _HGT_MISSING_ALLOWLIST_CACHE


def _require_hgt_auth_base(req):
    """Valid token, user, and HGT tool permission (no export quota)."""
    token = req.headers.get("Authorization", "")
    if token.startswith("Bearer "):
        token = token[len("Bearer ") :]
    if not token:
        raise PermissionError("Unauthorized")

    payload = verify_token(token)
    if not payload:
        raise PermissionError("Unauthorized")

    user = get_user_by_id(int(payload.get("uid", 0)))
    if not user:
        raise PermissionError("Unauthorized")

    # Tool permission logic:
    # - None/null: unrestricted
    # - []: explicitly no tools
    # - [...]: whitelist
    tools = user.get("allowed_tools")
    if tools is not None:
        if isinstance(tools, str) and tools.strip() == "":
            tools = None
        if isinstance(tools, list):
            if len(tools) == 0:
                raise PermissionError("No tools permitted")
            if "hgt" not in tools:
                raise PermissionError("HGT export not permitted")

    return user


def _require_hgt_auth_with_quota(req, base: str = "hgt", overlays=None):
    user = _require_hgt_auth_base(req)
    log_id = reserve_export_quota(
        user["id"],
        user["limit_day"],
        user["limit_week"],
        user["limit_month"],
        base,
        overlays if overlays is not None else {"hgt": True},
    )
    return user, log_id


def _hgt_prepare_export(data, logger):
    """
    Validate bbox and resolve HGT tiles. Returns (ctx, None) on success, or (None, (body, status)) on error.
    ctx includes: requested_tiles, present_paths, synthetic_water_tiles, data_root, hgt_dir,
    hgt_dir_available, zip_base, west, south, east, north, tile_debug_samples, missing_allowlist.
    """
    bbox = data.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        return (None, ("Invalid bbox: expected [west,south,east,north]", 400))
    try:
        west, south, east, north = [float(v) for v in bbox]
    except Exception:
        return (None, ("Invalid bbox coordinates", 400))

    if not all(map(math.isfinite, [west, south, east, north])):
        return (None, ("Invalid bbox coordinates", 400))
    # When the client is panned into a wrapped world copy, longitudes can be
    # shifted by +/-360 while still describing the same area. Normalize those.
    while west < -180 and east < -180:
        west += 360
        east += 360
    while west > 180 and east > 180:
        west -= 360
        east -= 360
    if not (-180 <= west <= 180 and -180 <= east <= 180 and -90 <= south <= 90 and -90 <= north <= 90):
        return (None, ("bbox out of bounds", 400))
    if west >= east or south >= north:
        return (None, ("Invalid bbox extent", 400))

    server_data_root = Path(__file__).resolve().parent / "data"
    repo_data_root = Path(__file__).resolve().parent.parent.parent / "data"
    data_root = server_data_root if server_data_root.exists() else repo_data_root

    hgt_dir = data_root / "srtmgl3" / "hgt"
    hgt_dir_available = hgt_dir.exists() and hgt_dir.is_dir()
    logger.info(
        "[HGT] Resolved hgt_dir=%s available=%s",
        str(hgt_dir.resolve()),
        hgt_dir_available,
    )
    logger.info("[HGT] Directory check: path=%s exists=%s is_dir=%s", str(hgt_dir), hgt_dir.exists(), hgt_dir.is_dir())

    requested_tiles = _hgt_tiles_for_bbox((west, south, east, north))
    logger.info(
        "[HGT] Bbox=%s requested_tiles_count=%s sample=%s",
        [west, south, east, north],
        len(requested_tiles),
        requested_tiles[:20],
    )
    logger.info("[HGT] Requested tiles: count=%s sample=%s", len(requested_tiles), requested_tiles[:10])
    if not requested_tiles:
        return (None, ("No HGT tiles intersect the requested bbox", 400))
    if len(requested_tiles) > _HGT_EXPORT_MAX_TILES:
        return (
            None,
            (
                f"HGT export cancelled: {len(requested_tiles)} tiles requested; "
                f"maximum allowed is {_HGT_EXPORT_MAX_TILES}. Reduce the bbox and try again.",
                413,
            ),
        )

    present_paths = []
    synthetic_water_tiles = []
    unresolved_missing_tiles = []
    missing_allowlist = _load_hgt_missing_allowlist()
    logger.info("[HGT] Missing allowlist loaded: size=%s", len(missing_allowlist))
    tile_debug_samples = []
    for tile_name in requested_tiles:
        p = hgt_dir / tile_name if hgt_dir_available else None
        exists = bool(p is not None and p.exists())
        is_file = bool(p is not None and p.is_file())
        in_allowlist = tile_name in missing_allowlist

        if len(tile_debug_samples) < 15:
            size = None
            if p is not None and exists:
                try:
                    size = p.stat().st_size
                except Exception:
                    size = None
            tile_debug_samples.append(
                {
                    "tile": tile_name,
                    "exists": exists,
                    "is_file": is_file,
                    "in_allowlist": in_allowlist,
                    "size": size,
                }
            )

        if p is not None and p.exists() and p.is_file():
            present_paths.append(p)
        elif in_allowlist:
            synthetic_water_tiles.append(tile_name)
        else:
            unresolved_missing_tiles.append(tile_name)

    logger.info(
        "[HGT] Tile classification: present=%s synthetic=%s unresolved=%s present_sample=%s synthetic_sample=%s unresolved_sample=%s",
        len(present_paths),
        len(synthetic_water_tiles),
        len(unresolved_missing_tiles),
        [p.name for p in present_paths[:10]],
        synthetic_water_tiles[:10],
        unresolved_missing_tiles[:10],
    )
    logger.info("[HGT] Tile debug samples=%s", tile_debug_samples)

    if not present_paths and not synthetic_water_tiles:
        logger.warning(
            "[HGT] No tiles for area data_root=%s hgt_dir=%s allowlist=%s "
            "requested=%s sample=%s debug=%s",
            data_root,
            hgt_dir,
            len(missing_allowlist),
            len(requested_tiles),
            requested_tiles[:20],
            tile_debug_samples,
        )
        return (None, ("No HGT elevation data available for this area.", 404))
    if unresolved_missing_tiles:
        logger.warning(
            "[HGT] Unresolved missing tiles=%s data_root=%s hgt_dir=%s debug=%s",
            unresolved_missing_tiles[:20],
            data_root,
            hgt_dir,
            tile_debug_samples,
        )
        return (
            None,
            (
                "Some HGT tiles for this area are unavailable. "
                f"Missing: {', '.join(unresolved_missing_tiles[:20])}",
                404,
            ),
        )

    custom_name = _sanitize_export_filename(data.get("filename"), "hgt_export")
    zip_base = custom_name[:-4] if custom_name.lower().endswith(".zip") else custom_name

    ctx = {
        "requested_tiles": requested_tiles,
        "present_paths": present_paths,
        "synthetic_water_tiles": synthetic_water_tiles,
        "data_root": data_root,
        "hgt_dir": hgt_dir,
        "hgt_dir_available": hgt_dir_available,
        "zip_base": zip_base,
        "west": west,
        "south": south,
        "east": east,
        "north": north,
        "tile_debug_samples": tile_debug_samples,
        "missing_allowlist": missing_allowlist,
    }
    return (ctx, None)


@app.route("/export_hgt", methods=["POST"])
def export_hgt():
    import logging

    logger = logging.getLogger(__name__)
    export_log_id = None

    try:
        try:
            user, export_log_id = _require_hgt_auth_with_quota(request, base="hgt", overlays={"hgt": True})
        except PermissionError as pe:
            message = str(pe) or "Unauthorized"
            status = 401 if message == "Unauthorized" else 403
            return (message, status)

        data = request.get_json(force=True) or {}
        ctx, err = _hgt_prepare_export(data, logger)
        if err:
            release_export_quota(export_log_id)
            body, status = err
            return (body, status)

        present_paths = ctx["present_paths"]
        synthetic_water_tiles = ctx["synthetic_water_tiles"]
        hgt_dir_available = ctx["hgt_dir_available"]
        zip_base = ctx["zip_base"]
        requested_tiles = ctx["requested_tiles"]
        present_tile_names = {p.name for p in present_paths}
        synthetic_tile_names = set(synthetic_water_tiles)
        base = str(data.get("base") or "esri")
        zoom = int(data.get("zoom") or 8)
        system = data.get("system")

        # Activity — HGT export params + tile inventory + resolved identity
        _hgt_bbox = [ctx["west"], ctx["south"], ctx["east"], ctx["north"]]
        activity.enrich(
            user=user,
            export_type="hgt",
            base=base,
            overlays=data.get("overlays") or {},
            zoom=zoom,
            system=system,
            quality=data.get("quality"),
            crs=data.get("crs"),
            filename=data.get("filename"),
            bbox=_hgt_bbox,
            bbox_area_km2=activity.bbox_area_km2(_hgt_bbox),
            bbox_center=activity.bbox_center(_hgt_bbox),
            tiles_requested=len(requested_tiles),
            tiles_present=len(present_paths),
            tiles_synthetic_water=len(synthetic_water_tiles),
            hgt_dir_available=hgt_dir_available,
            zip_base=zip_base,
        )

        map_overlay_png_bytes = None
        png_name = None
        try:
            map_overlay_png_bytes = _build_hgt_map_with_grid_png_bytes(
                requested_tiles,
                present_tile_names,
                synthetic_tile_names,
                base,
                zoom,
                system,
            )
            png_ts = time.strftime("%Y%m%d_%H%M%S", time.gmtime())
            png_name = f"{zip_base}_map_with_hgt_grid_{png_ts}.png"
        except Exception as e:
            logger.warning("[HGT] Failed to build map-overlay PNG for zip export: %s", e)

        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            for p in present_paths:
                zf.write(p, arcname=f"hgt/{p.name}")
            for tile_name in synthetic_water_tiles:
                zf.writestr(f"hgt/{tile_name}", _HGT_WATER_TILE_BYTES)
            if map_overlay_png_bytes is not None and png_name is not None:
                zf.writestr(png_name, map_overlay_png_bytes)
        zip_size = zip_buf.tell()
        zip_buf.seek(0)

        # Activity — zip output size (only reachable on success)
        activity.enrich(bytes_produced=zip_size)

        logger.info(
            "[HGT] Exported %s local tiles + %s synthetic water tiles for bbox=%s",
            len(present_paths),
            len(synthetic_water_tiles),
            [ctx["west"], ctx["south"], ctx["east"], ctx["north"]],
        )
        if not hgt_dir_available:
            logger.warning("[HGT] Local HGT dataset directory unavailable, served synthetic-only where allowlisted")
        return send_file(
            zip_buf,
            mimetype="application/zip",
            as_attachment=True,
            download_name=f"{zip_base}_{time.strftime('%Y%m%d_%H%M%S', time.gmtime())}.zip",
        )
    except Exception as e:
        release_export_quota(export_log_id)
        logger.exception("[HGT] Export failed")
        activity.enrich(error_message=str(e)[:300])
        return _http_500("HGT export failed", exc=e)


@app.route("/export_hgt_map_tiff", methods=["POST"])
def export_hgt_map_tiff():
    """Map + HGT grid overlay PNG; separate download from the HGT zip (same bbox/auth as /export_hgt)."""
    import logging

    logger = logging.getLogger(__name__)
    export_log_id = None

    try:
        try:
            user, export_log_id = _require_hgt_auth_with_quota(
                request, base="hgt_map", overlays={"hgt": True, "map_png": True}
            )
        except PermissionError as pe:
            message = str(pe) or "Unauthorized"
            status = 401 if message == "Unauthorized" else 403
            return (message, status)

        data = request.get_json(force=True) or {}
        ctx, err = _hgt_prepare_export(data, logger)
        if err:
            release_export_quota(export_log_id)
            body, status = err
            return (body, status)

        requested_tiles = ctx["requested_tiles"]
        present_tile_names = {p.name for p in ctx["present_paths"]}
        synthetic_tile_names = set(ctx["synthetic_water_tiles"])
        zip_base = ctx["zip_base"]
        base = str(data.get("base") or "esri")
        zoom = int(data.get("zoom") or 8)
        system = data.get("system")
        _hgt_bbox = [ctx["west"], ctx["south"], ctx["east"], ctx["north"]]

        activity.enrich(
            user=user,
            export_type="hgt_map_png",
            base=base,
            overlays=data.get("overlays") or {},
            zoom=zoom,
            system=system,
            quality=data.get("quality"),
            crs=data.get("crs"),
            filename=data.get("filename"),
            bbox=_hgt_bbox,
            tiles_requested=len(requested_tiles),
            zip_base=zip_base,
        )

        try:
            map_overlay_png_bytes = _build_hgt_map_with_grid_png_bytes(
                requested_tiles,
                present_tile_names,
                synthetic_tile_names,
                base,
                zoom,
                system,
            )
        except Exception as e:
            release_export_quota(export_log_id)
            logger.exception("[HGT] Map PNG build failed")
            activity.enrich(error_message=str(e)[:300])
            return _http_500("HGT map PNG failed", exc=e)

        png_buf = io.BytesIO(map_overlay_png_bytes)
        png_buf.seek(0)
        png_ts = time.strftime("%Y%m%d_%H%M%S", time.gmtime())
        activity.enrich(bytes_produced=len(map_overlay_png_bytes))
        return send_file(
            png_buf,
            mimetype="image/png",
            as_attachment=True,
            download_name=f"{zip_base}_map_with_hgt_grid_{png_ts}.png",
        )
    except Exception as e:
        release_export_quota(export_log_id)
        logger.exception("[HGT] Map PNG export failed")
        activity.enrich(error_message=str(e)[:300])
        return _http_500("HGT map PNG export failed", exc=e)


# --- SHOM tile proxy ---------------------------------------------------------

# WMTS template recommended for SHOM charts (WebMercator 3857 tile matrix)
SHOM_TILE_TEMPLATE = (
    "https://services.data.shom.fr/clevisu/wmts?layer=RASTER_MARINE_3857_WMTS&style=normal&tilematrixset=3857"
    "&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/png&TileMatrix={z}&TileCol={x}&TileRow={y}"
)

TILE_REFERER = os.getenv("TILE_REFERER", "https://data.shom.fr/")

# --- UKHO Discovery API (trial-only) ----------------------------------------
# Auth only via `Ocp-Apim-Subscription-Key` header.
UKHO_DISCOVERY_ENABLED_RAW = os.getenv("UKHO_DISCOVERY_ENABLED", "").strip()


def _parse_bool_env(v: str) -> bool:
    return str(v).strip().lower() in ("1", "true", "t", "yes", "y", "on")


UKHO_DISCOVERY_WMS_BASE_URL = os.getenv("UKHO_DISCOVERY_WMS_BASE_URL", "").strip()
UKHO_DISCOVERY_SUBSCRIPTION_KEY = os.getenv("UKHO_DISCOVERY_SUBSCRIPTION_KEY", "").strip()
UKHO_DISCOVERY_API_KEY_HEADER = "Ocp-Apim-Subscription-Key"

# Optional trial-specific WMS parameters (only forwarded if set).
# Some UKHO trial examples require Display_params to produce non-transparent chart output.
UKHO_DISCOVERY_WMS_DISPLAY_PARAMS = os.getenv("UKHO_DISCOVERY_WMS_DISPLAY_PARAMS", "").strip()
UKHO_DISCOVERY_WMS_INFO_FORMAT = os.getenv("UKHO_DISCOVERY_WMS_INFO_FORMAT", "").strip()

# WMS styles/transparent controls can be overridden for trial quirks if needed.
UKHO_DISCOVERY_WMS_STYLES = os.getenv("UKHO_DISCOVERY_WMS_STYLES", "").strip()
UKHO_DISCOVERY_WMS_TRANSPARENT = os.getenv("UKHO_DISCOVERY_WMS_TRANSPARENT", "TRUE").strip().upper()

UKHO_WMS_LAYERS = os.getenv("UKHO_WMS_LAYERS", "").strip()

# Legacy env vars (kept for compatibility with existing deployments)
UKHO_WMS_URL_LEGACY = os.getenv(
    "UKHO_WMS_URL",
    "https://admiraltyapi.azure-api.net/avcso-disco/WMSServer",
).strip()
UKHO_SUBSCRIPTION_KEY_LEGACY = os.getenv(
    "UKHO_SUBSCRIPTION_KEY",
    os.getenv("UKHO_API_KEY", ""),
).strip()

UKHO_WMS_URL = UKHO_DISCOVERY_WMS_BASE_URL or UKHO_WMS_URL_LEGACY
UKHO_SUBSCRIPTION_KEY = UKHO_DISCOVERY_SUBSCRIPTION_KEY or UKHO_SUBSCRIPTION_KEY_LEGACY

if UKHO_DISCOVERY_ENABLED_RAW != "":
    UKHO_DISCOVERY_ENABLED = _parse_bool_env(UKHO_DISCOVERY_ENABLED_RAW)
else:
    UKHO_DISCOVERY_ENABLED = bool(UKHO_WMS_URL and UKHO_SUBSCRIPTION_KEY)

# Keep existing variable names so other code keeps working.
UKHO_API_KEY_HEADER = UKHO_DISCOVERY_API_KEY_HEADER

# Short timeout: rely on negative caching + backoff.
UKHO_DISCOVERY_TILE_TIMEOUT = float(os.getenv("UKHO_DISCOVERY_TILE_TIMEOUT", os.getenv("UKHO_TILE_TIMEOUT", "5")))
UKHO_TILE_TIMEOUT = UKHO_DISCOVERY_TILE_TIMEOUT

UKHO_DISCOVERY_POS_CACHE_SECONDS = int(os.getenv("UKHO_DISCOVERY_POS_CACHE_SECONDS", "60"))
UKHO_DISCOVERY_NEG_CACHE_SECONDS = int(os.getenv("UKHO_DISCOVERY_NEG_CACHE_SECONDS", "15"))
UKHO_DISCOVERY_CACHE_MAX_ENTRIES = int(os.getenv("UKHO_DISCOVERY_CACHE_MAX_ENTRIES", "1024"))

UKHO_DISCOVERY_MAX_CONCURRENT = int(os.getenv("UKHO_DISCOVERY_MAX_CONCURRENT", "2"))
UKHO_DISCOVERY_SEMAPHORE_TIMEOUT = float(os.getenv("UKHO_DISCOVERY_SEMAPHORE_TIMEOUT", "2"))

_ukho_pos_cache = {}  # key -> {"exp": float, "png": bytes}
_ukho_neg_cache = {}  # key -> exp float
_ukho_cache_lock = threading.Lock()
_ukho_upstream_semaphore = threading.Semaphore(UKHO_DISCOVERY_MAX_CONCURRENT)
_ukho_global_backoff_until = 0.0
_ukho_wms_request_sig = hashlib.sha256(
    f"{UKHO_WMS_LAYERS}|{UKHO_DISCOVERY_WMS_DISPLAY_PARAMS}|{UKHO_DISCOVERY_WMS_INFO_FORMAT}|{UKHO_DISCOVERY_WMS_STYLES}|{UKHO_DISCOVERY_WMS_TRANSPARENT}".encode(
        "utf-8"
    )
).hexdigest()[:16]

UKHO_STATUS_SAMPLE_BBOX = os.getenv(
    "UKHO_STATUS_SAMPLE_BBOX",
    "-178955.85052648446,6562022.126722074,-169401.22199085026,6571576.755257708",
).strip()

# In-memory cache for failed SHOM tiles to avoid repeated requests
_shom_failed_tiles = {}
_shom_cache_ttl = 300  # 5 minutes cache for failed tiles


@app.get("/tiles/shom/<int:z>/<int:x>/<int:y>.<ext>")
def shom_tile(z: int, x: int, y: int, ext: str):
    if not _require_user(request):
        return ("Unauthorized", 401)
    # SHOM tiles are typically not available beyond zoom level 18
    if z > 18:
        return ("SHOM tiles not available at this zoom level", 404)

    # Check if this tile recently failed
    tile_key = f"{z}_{x}_{y}"
    current_time = time.time()

    if tile_key in _shom_failed_tiles:
        last_fail_time = _shom_failed_tiles[tile_key]
        if current_time - last_fail_time < _shom_cache_ttl:
            return ("Tile recently failed, cached failure", 404)

    try:
        url = SHOM_TILE_TEMPLATE.replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))
        # Upstream expects a Referer header
        resp = requests.get(
            url,
            headers={
                "Referer": TILE_REFERER,
                "User-Agent": "scepmaps/1.0 (+https://data.shom.fr/)",
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                "Cache-Control": "max-age=3600",  # Allow caching for better performance
            },
            timeout=10,  # Reduced timeout to fail faster
        )
        if resp.status_code != 200:
            # Cache the failure to avoid repeated requests
            _shom_failed_tiles[tile_key] = current_time
            return (f"Upstream error fetching tile: {resp.status_code}", resp.status_code)

        # Clear from failed cache if request succeeds
        if tile_key in _shom_failed_tiles:
            del _shom_failed_tiles[tile_key]

        content_type = resp.headers.get("Content-Type", "image/png")
        return send_file(io.BytesIO(resp.content), mimetype=content_type)
    except Exception as e:
        # Cache the failure
        _shom_failed_tiles[tile_key] = current_time
        return _http_500("Tile proxy error", exc=e)


def _mercator_tile_bbox_3857(z: int, x: int, y: int):
    """Return EPSG:3857 bbox for XYZ tile coordinates."""
    n = 2**z
    lon_w = x / n * 360.0 - 180.0
    lon_e = (x + 1) / n * 360.0 - 180.0
    lat_n = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    lat_s = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))

    origin_shift = 20037508.342789244
    mx_w = lon_w * origin_shift / 180.0
    mx_e = lon_e * origin_shift / 180.0

    def lat_to_my(lat_deg: float) -> float:
        lat_rad = math.radians(max(min(lat_deg, 89.5), -89.5))
        return 6378137.0 * math.log(math.tan(math.pi / 4.0 + lat_rad / 2.0))

    my_s = lat_to_my(lat_s)
    my_n = lat_to_my(lat_n)
    return mx_w, my_s, mx_e, my_n


def _build_ukho_getmap_params(minx: float, miny: float, maxx: float, maxy: float, width: int = 256, height: int = 256):
    params = {
        "SERVICE": "WMS",
        "REQUEST": "GetMap",
        "VERSION": "1.3.0",
        "STYLES": UKHO_DISCOVERY_WMS_STYLES or "",
        "FORMAT": "image/png",
        "TRANSPARENT": UKHO_DISCOVERY_WMS_TRANSPARENT,
        "CRS": "EPSG:3857",
        "BBOX": f"{minx},{miny},{maxx},{maxy}",
        "WIDTH": str(width),
        "HEIGHT": str(height),
    }

    # Keep LAYERS unset by default; only forward if explicitly configured.
    if UKHO_WMS_LAYERS:
        params["LAYERS"] = UKHO_WMS_LAYERS

    # Keep Display_params unset unless explicitly configured.
    if UKHO_DISCOVERY_WMS_DISPLAY_PARAMS:
        params["Display_params"] = UKHO_DISCOVERY_WMS_DISPLAY_PARAMS

    if UKHO_DISCOVERY_WMS_INFO_FORMAT:
        params["info_format"] = UKHO_DISCOVERY_WMS_INFO_FORMAT

    return params


def _log_ukho_forwarded_params(params, context: str):
    import logging

    logger = logging.getLogger(__name__)
    safe_keys = [
        "SERVICE",
        "REQUEST",
        "VERSION",
        "FORMAT",
        "TRANSPARENT",
        "CRS",
        "BBOX",
        "WIDTH",
        "HEIGHT",
        "LAYERS",
        "Display_params",
    ]
    safe = {k: params.get(k) for k in safe_keys if k in params}
    logger.info("UKHO %s forwarded GetMap params=%s", context, safe)


def _analyze_png_bytes(image_bytes: bytes):
    out = {
        "is_png": False,
        "width": None,
        "height": None,
        "has_nontransparent_pixels": False,
    }
    try:
        img = Image.open(io.BytesIO(image_bytes))
        out["is_png"] = img.format == "PNG"
        out["width"], out["height"] = img.size
        rgba = img.convert("RGBA")
        out["has_nontransparent_pixels"] = rgba.getchannel("A").getbbox() is not None
    except Exception:
        pass
    return out


def _save_ukho_debug_png(image_bytes: bytes, prefix: str):
    if not _parse_bool_env(os.getenv("UKHO_DISCOVERY_DEBUG_SAVE_PNGS", "false")):
        return None
    try:
        d = os.getenv("UKHO_DISCOVERY_DEBUG_DIR", "/tmp/ukho-discovery-debug")
        os.makedirs(d, exist_ok=True)
        ts = int(time.time() * 1000)
        path = os.path.join(d, f"{prefix}-{ts}.png")
        with open(path, "wb") as f:
            f.write(image_bytes)
        return path
    except Exception:
        return None


@app.get("/tiles/ukho/<int:z>/<int:x>/<int:y>.png")
def ukho_tile(z: int, x: int, y: int):
    if not _require_user(request):
        return ("Unauthorized", 401)
    if not UKHO_DISCOVERY_ENABLED or not UKHO_WMS_URL or not UKHO_SUBSCRIPTION_KEY:
        return ("UKHO Discovery disabled/not configured", 404)
    if z > 18:
        return ("UKHO tiles not available at this zoom level", 404)

    global _ukho_global_backoff_until
    tile_key = f"{_ukho_wms_request_sig}:{z}/{x}/{y}"
    now = time.time()

    with _ukho_cache_lock:
        if len(_ukho_pos_cache) > UKHO_DISCOVERY_CACHE_MAX_ENTRIES:
            _ukho_pos_cache.clear()
        if len(_ukho_neg_cache) > UKHO_DISCOVERY_CACHE_MAX_ENTRIES:
            _ukho_neg_cache.clear()

        pos = _ukho_pos_cache.get(tile_key)
        if pos and pos["exp"] > now:
            resp = send_file(io.BytesIO(pos["png"]), mimetype="image/png", max_age=UKHO_DISCOVERY_POS_CACHE_SECONDS)
            if pos.get("is_empty"):
                resp.headers["X-UKHO-Empty"] = "1"
            return resp

        neg_exp = _ukho_neg_cache.get(tile_key)
        if neg_exp and neg_exp > now:
            return ("UKHO tile cached failure", 404)
        if now < _ukho_global_backoff_until:
            return ("UKHO Discovery temporarily rate limited", 404)

    acquired = _ukho_upstream_semaphore.acquire(timeout=UKHO_DISCOVERY_SEMAPHORE_TIMEOUT)
    if not acquired:
        return ("UKHO Discovery busy", 404)

    try:
        minx, miny, maxx, maxy = _mercator_tile_bbox_3857(z, x, y)
        params = _build_ukho_getmap_params(minx, miny, maxx, maxy, 256, 256)
        _log_ukho_forwarded_params(params, context=f"tile z={z} x={x} y={y}")

        headers = {
            "User-Agent": "scepmaps/1.0 (+UKHO discovery proxy)",
            "Accept": "image/png,*/*;q=0.8",
            "Cache-Control": "no-cache",
            UKHO_API_KEY_HEADER: UKHO_SUBSCRIPTION_KEY,
        }
        resp = requests.get(UKHO_WMS_URL, params=params, headers=headers, timeout=UKHO_TILE_TIMEOUT)
        content_type = (resp.headers.get("Content-Type", "") or "").lower()
        if resp.status_code != 200 or "text/html" in content_type or "application/json" in content_type:
            if resp.status_code in (429, 503):
                retry_after = resp.headers.get("Retry-After")
                backoff = UKHO_DISCOVERY_NEG_CACHE_SECONDS
                try:
                    if retry_after:
                        backoff = float(retry_after)
                except Exception:
                    backoff = UKHO_DISCOVERY_NEG_CACHE_SECONDS
                with _ukho_cache_lock:
                    global_backoff = now + max(UKHO_DISCOVERY_NEG_CACHE_SECONDS, backoff)
                    if global_backoff > _ukho_global_backoff_until:
                        _ukho_global_backoff_until = global_backoff
            with _ukho_cache_lock:
                _ukho_neg_cache[tile_key] = now + UKHO_DISCOVERY_NEG_CACHE_SECONDS
            return ("UKHO tile unavailable", 404)

        image_bytes = resp.content
        analysis = _analyze_png_bytes(image_bytes)
        _save_ukho_debug_png(image_bytes, prefix=f"tile-{z}-{x}-{y}")
        is_empty = not analysis.get("has_nontransparent_pixels", False)

        with _ukho_cache_lock:
            _ukho_pos_cache[tile_key] = {
                "exp": now + UKHO_DISCOVERY_POS_CACHE_SECONDS,
                "png": image_bytes,
                "is_empty": is_empty,
            }

        out = send_file(io.BytesIO(image_bytes), mimetype="image/png", max_age=UKHO_DISCOVERY_POS_CACHE_SECONDS)
        if is_empty:
            out.headers["X-UKHO-Empty"] = "1"
        return out
    except Exception:
        import logging

        logging.getLogger(__name__).exception("UKHO tile proxy error")
        return ("UKHO tile proxy error", 500)
    finally:
        try:
            _ukho_upstream_semaphore.release()
        except Exception:
            pass


@app.get("/api/ukho/status")
def ukho_status():
    """Quick diagnostic endpoint for UKHO Discovery connectivity."""
    if not _require_admin(request):
        return ({"error": "Unauthorized"}, 401)
    configured = bool(UKHO_WMS_URL and UKHO_SUBSCRIPTION_KEY)
    enabled = bool(UKHO_DISCOVERY_ENABLED)
    if not (enabled and configured):
        return {
            "enabled": enabled,
            "configured": configured,
            "error": "UKHO Discovery disabled or missing UKHO_DISCOVERY_* configuration",
        }, 200
    try:
        headers = {
            UKHO_API_KEY_HEADER: UKHO_SUBSCRIPTION_KEY,
            "User-Agent": "scepmaps/1.0 (+UKHO status probe)",
            "Accept": "image/png,*/*;q=0.8",
        }
        params = {
            "SERVICE": "WMS",
            "REQUEST": "GetMap",
            "VERSION": "1.3.0",
            "STYLES": UKHO_DISCOVERY_WMS_STYLES or "",
            "FORMAT": "image/png",
            "TRANSPARENT": UKHO_DISCOVERY_WMS_TRANSPARENT,
            "CRS": "EPSG:3857",
            "BBOX": UKHO_STATUS_SAMPLE_BBOX,
            "WIDTH": "256",
            "HEIGHT": "256",
        }
        if UKHO_WMS_LAYERS:
            params["LAYERS"] = UKHO_WMS_LAYERS
        if UKHO_DISCOVERY_WMS_DISPLAY_PARAMS:
            params["Display_params"] = UKHO_DISCOVERY_WMS_DISPLAY_PARAMS
        if UKHO_DISCOVERY_WMS_INFO_FORMAT:
            params["info_format"] = UKHO_DISCOVERY_WMS_INFO_FORMAT
        _log_ukho_forwarded_params(params, context="status")
        resp = requests.get(UKHO_WMS_URL, params=params, headers=headers, timeout=UKHO_TILE_TIMEOUT)
        ct = resp.headers.get("Content-Type", "")
        result = {
            "enabled": enabled,
            "configured": True,
            "upstream_status": resp.status_code,
            "content_type": ct,
            "sample_bbox": UKHO_STATUS_SAMPLE_BBOX,
        }
        if resp.status_code == 200 and "image/png" in (ct or "").lower():
            try:
                rgba = Image.open(io.BytesIO(resp.content)).convert("RGBA")
                result["non_transparent_pixels"] = bool(rgba.getchannel("A").getbbox())
            except Exception as e:
                result["image_parse_error"] = str(e)
        else:
            result["preview"] = (resp.text or "")[:300]
        return result, 200
    except Exception as e:
        return {"enabled": enabled, "configured": True, "error": "UKHO status probe failed"}, 200


@app.get("/api/ukho/probe")
def ukho_probe():
    """
    Probe UKHO Discovery GetMap for a specific BBOX and return image diagnostics.
    """
    if not _require_admin(request):
        return {"error": "Unauthorized"}, 401
    if not UKHO_DISCOVERY_ENABLED or not UKHO_WMS_URL or not UKHO_SUBSCRIPTION_KEY:
        return {"error": "UKHO Discovery disabled/not configured"}, 404

    bbox = (request.args.get("bbox", "") or "").strip()
    parts = [p.strip() for p in bbox.split(",")] if bbox else []
    if len(parts) != 4:
        return {"error": "bbox must be minx,miny,maxx,maxy in EPSG:3857"}, 400
    try:
        minx, miny, maxx, maxy = [float(p) for p in parts]
    except Exception:
        return {"error": "invalid bbox floats"}, 400
    try:
        width = int(request.args.get("width", "256"))
        height = int(request.args.get("height", "256"))
    except Exception:
        return {"error": "invalid width/height"}, 400

    params = _build_ukho_getmap_params(minx, miny, maxx, maxy, width, height)
    _log_ukho_forwarded_params(params, context="probe")
    headers = {
        "User-Agent": "scepmaps/1.0 (+UKHO probe)",
        "Accept": "image/png,*/*;q=0.8",
        UKHO_API_KEY_HEADER: UKHO_SUBSCRIPTION_KEY,
    }
    try:
        resp = requests.get(UKHO_WMS_URL, params=params, headers=headers, timeout=UKHO_TILE_TIMEOUT)
        image_bytes = resp.content or b""
        analysis = _analyze_png_bytes(image_bytes)
        debug_path = _save_ukho_debug_png(image_bytes, prefix="probe")
        result = {
            "status_code": resp.status_code,
            "content_type": resp.headers.get("Content-Type", ""),
            "bytes": len(image_bytes),
            "is_png": analysis["is_png"],
            "width": analysis["width"],
            "height": analysis["height"],
            "has_nontransparent_pixels": analysis["has_nontransparent_pixels"],
        }
        if debug_path:
            result["debug_png_path"] = debug_path
        return result, 200
    except Exception:
        return {"error": "probe failed"}, 500


@app.get("/api/ukho/probe/southcoast")
def ukho_probe_southcoast():
    """
    Probe several south-coast candidate BBOX values and report which return non-transparent pixels.
    """
    if not _require_admin(request):
        return {"error": "Unauthorized"}, 401
    if not UKHO_DISCOVERY_ENABLED or not UKHO_WMS_URL or not UKHO_SUBSCRIPTION_KEY:
        return {"error": "UKHO Discovery disabled/not configured"}, 404

    candidates = [
        {"name": "Plymouth", "bbox": "-500937.7,6515839.1,-491383.1,6525393.7"},
        {"name": "Falmouth", "bbox": "-561847.0,6621293.7,-552292.4,6630848.3"},
        {"name": "Portsmouth", "bbox": "-132282.2,6557247.4,-122727.6,6566802.0"},
        {"name": "Solent", "bbox": "-177225.7,6563492.7,-167671.1,6573047.3"},
        {"name": "Dover", "bbox": "63196.1,6562222.1,72750.8,6571776.8"},
        {"name": "Brighton", "bbox": "-50093.8,6515839.1,-40539.2,6525393.7"},
    ]
    width = int(request.args.get("width", "256"))
    height = int(request.args.get("height", "256"))

    headers = {
        "User-Agent": "scepmaps/1.0 (+UKHO southcoast probe)",
        "Accept": "image/png,*/*;q=0.8",
        UKHO_API_KEY_HEADER: UKHO_SUBSCRIPTION_KEY,
    }

    results = []
    for c in candidates:
        minx, miny, maxx, maxy = [float(v) for v in c["bbox"].split(",")]
        params = _build_ukho_getmap_params(minx, miny, maxx, maxy, width, height)
        _log_ukho_forwarded_params(params, context=f"southcoast:{c['name']}")
        try:
            resp = requests.get(UKHO_WMS_URL, params=params, headers=headers, timeout=UKHO_TILE_TIMEOUT)
            analysis = _analyze_png_bytes(resp.content or b"")
            results.append(
                {
                    "name": c["name"],
                    "bbox": c["bbox"],
                    "status_code": resp.status_code,
                    "content_type": resp.headers.get("Content-Type", ""),
                    "bytes": len(resp.content or b""),
                    "has_nontransparent_pixels": analysis["has_nontransparent_pixels"],
                }
            )
        except Exception:
            results.append(
                {
                    "name": c["name"],
                    "bbox": c["bbox"],
                    "error": "request failed",
                }
            )

    return {"results": results}, 200


@app.get("/ukho/wms")
def ukho_wms_passthrough():
    """
    Optional passthrough WMS endpoint (trial-only).
    Strictly forwards to Discovery API with only safe display parameters.
    """
    if not UKHO_DISCOVERY_ENABLED or not UKHO_WMS_URL or not UKHO_SUBSCRIPTION_KEY:
        return ("UKHO Discovery disabled/not configured", 404)

    def _parse_bbox(b: str):
        parts = [p.strip() for p in (b or "").split(",")]
        if len(parts) != 4:
            return None
        try:
            vals = [float(p) for p in parts]
            if not all(map(lambda v: math.isfinite(v), vals)):
                return None
            return vals  # minx,miny,maxx,maxy
        except Exception:
            return None

    bbox = _parse_bbox(request.args.get("bbox", ""))
    if bbox is None:
        return ("Missing/invalid bbox. Expected minx,miny,maxx,maxy in EPSG:3857.", 400)

    crs = request.args.get("crs", "EPSG:3857").strip()
    if crs not in ("EPSG:3857", "EPSG%3A3857"):
        return ("Only EPSG:3857 supported.", 400)
    try:
        width = int(request.args.get("width", "256"))
        height = int(request.args.get("height", "256"))
    except Exception:
        return ("Invalid width/height.", 400)

    if width <= 0 or height <= 0 or width > 512 or height > 512:
        return ("width/height out of bounds.", 400)

    # Restrict layers to what the server is configured to request.
    styles = (request.args.get("styles", "") or "").strip()
    if len(styles) > 200:
        return ("styles too long.", 400)

    display_params = (request.args.get("display_params", "") or "").strip()
    if len(display_params) > 4000:
        return ("display_params too long.", 400)

    info_format = (request.args.get("info_format", "") or "").strip()
    if len(info_format) > 200:
        return ("info_format too long.", 400)

    try:
        minx, miny, maxx, maxy = bbox
        params = {
            "SERVICE": "WMS",
            "REQUEST": "GetMap",
            "VERSION": "1.3.0",
            "STYLES": styles,
            "FORMAT": "image/png",
            "TRANSPARENT": "TRUE",
            "CRS": "EPSG:3857",
            "BBOX": f"{minx},{miny},{maxx},{maxy}",
            "WIDTH": str(width),
            "HEIGHT": str(height),
        }
        if UKHO_WMS_LAYERS:
            params["LAYERS"] = UKHO_WMS_LAYERS

        # Optional trial-specific parameters.
        if display_params:
            params["Display_params"] = display_params
        elif UKHO_DISCOVERY_WMS_DISPLAY_PARAMS:
            params["Display_params"] = UKHO_DISCOVERY_WMS_DISPLAY_PARAMS

        if info_format:
            params["info_format"] = info_format
        elif UKHO_DISCOVERY_WMS_INFO_FORMAT:
            params["info_format"] = UKHO_DISCOVERY_WMS_INFO_FORMAT
        _log_ukho_forwarded_params(params, context="wms-passthrough")

        headers = {
            "User-Agent": "scepmaps/1.0 (+UKHO wms proxy)",
            "Accept": "image/png,*/*;q=0.8",
            UKHO_API_KEY_HEADER: UKHO_SUBSCRIPTION_KEY,
        }

        resp = requests.get(
            UKHO_WMS_URL,
            params=params,
            headers=headers,
            timeout=UKHO_TILE_TIMEOUT,
        )

        content_type = (resp.headers.get("Content-Type", "") or "").lower()
        if resp.status_code != 200 or "image/png" not in content_type:
            return ("UKHO wms tile unavailable", 404)

        image_bytes = resp.content
        try:
            rgba = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
            if rgba.getchannel("A").getbbox() is None:
                return ("UKHO wms empty tile", 404)
        except Exception:
            pass

        return send_file(io.BytesIO(image_bytes), mimetype="image/png")
    except Exception:
        import logging

        logging.getLogger(__name__).exception("UKHO wms passthrough error")
        return ("UKHO wms proxy error", 500)


# --- ArcGIS tile proxy ------------------------------------------------------

# Load API key from environment (check both direct env and .env file)
ARCGIS_API_KEY = os.getenv("ARCGIS_API_KEY")
if not ARCGIS_API_KEY:
    # Try loading from .env file if not in environment
    from pathlib import Path

    # Check source_code/server/.env first, then repo root .env
    env_paths = [
        Path(__file__).parent / ".env",  # source_code/server/.env
        Path(__file__).parent.parent.parent / ".env",  # repo root .env
    ]
    for env_path in env_paths:
        if env_path.exists():
            from dotenv import dotenv_values

            env_vars = dotenv_values(env_path)
            ARCGIS_API_KEY = env_vars.get("ARCGIS_API_KEY")
            if ARCGIS_API_KEY:
                break


def _arcgis_upstream_get(url: str, timeout: int = 15):
    """Fetch an ArcGIS URL with the server-side API key (never exposed to clients)."""
    clean = validate_arcgis_url(url)
    params = {"token": ARCGIS_API_KEY} if ARCGIS_API_KEY else {}
    return requests.get(clean, params=params, headers=arcgis_upstream_headers(), timeout=timeout)


@app.get("/tiles/arcgis/vector/<int:z>/<int:x>/<int:y>.<ext>")
def arcgis_vector_tile(z: int, x: int, y: int, ext: str):
    """Proxy ArcGIS vector tiles — API key added server-side."""
    if not _require_user(request):
        return ("Unauthorized", 401)
    if not ARCGIS_API_KEY:
        return ("ArcGIS API key not configured", 500)
    enc = request.args.get("u", "")
    if not enc:
        return ("Missing tile upstream parameter", 400)
    try:
        template = decode_upstream(enc)
        upstream = resolve_vector_tile_url(template, z, x, y)
        resp = _arcgis_upstream_get(upstream)
        if resp.status_code != 200:
            return (f"ArcGIS vector tile error: {resp.status_code}", resp.status_code)
        mimetype = resp.headers.get("Content-Type") or "application/vnd.mapbox-vector-tile"
        return send_file(io.BytesIO(resp.content), mimetype=mimetype)
    except ValueError as e:
        return (str(e), 400)
    except Exception as e:
        return _http_500("ArcGIS vector tile proxy error", exc=e)


@app.get("/api/arcgis/res/<path:spec>")
def arcgis_sprite_resource(spec: str):
    """Proxy ArcGIS sprite sheets (MapLibre appends .json / .png to the style sprite URL)."""
    if not _require_user(request):
        return ("Unauthorized", 401)
    if not ARCGIS_API_KEY:
        return ("ArcGIS API key not configured", 500)
    try:
        upstream = resolve_sprite_resource(spec)
        resp = _arcgis_upstream_get(upstream)
        if resp.status_code != 200:
            return (f"ArcGIS sprite error: {resp.status_code}", resp.status_code)
        mimetype = resp.headers.get("Content-Type") or (
            "application/json" if spec.endswith(".json") else "image/png"
        )
        return send_file(io.BytesIO(resp.content), mimetype=mimetype)
    except ValueError as e:
        return (str(e), 400)
    except Exception as e:
        return _http_500("ArcGIS sprite proxy error", exc=e)


@app.get("/api/arcgis/glyphs/<enc>/<path:fontstack>/<range_id>.pbf")
def arcgis_glyphs(enc: str, fontstack: str, range_id: str):
    """Proxy ArcGIS glyph PBFs for vector label rendering."""
    if not _require_user(request):
        return ("Unauthorized", 401)
    if not ARCGIS_API_KEY:
        return ("ArcGIS API key not configured", 500)
    try:
        template = decode_upstream(enc)
        upstream = resolve_glyph_url(template, fontstack, range_id)
        resp = _arcgis_upstream_get(upstream)
        if resp.status_code != 200:
            return (f"ArcGIS glyphs error: {resp.status_code}", resp.status_code)
        mimetype = resp.headers.get("Content-Type") or "application/x-protobuf"
        return send_file(io.BytesIO(resp.content), mimetype=mimetype)
    except ValueError as e:
        return (str(e), 400)
    except Exception as e:
        return _http_500("ArcGIS glyphs proxy error", exc=e)


@app.get("/api/arcgis/tilejson")
def arcgis_tilejson():
    """Fetch ArcGIS TileJSON server-side and rewrite embedded tile URLs to local proxies."""
    if not _require_user(request):
        return jsonify({"error": "Unauthorized"}), 401
    if not ARCGIS_API_KEY:
        return jsonify({"error": "ArcGIS API key not configured"}), 500
    enc = request.args.get("u", "")
    if not enc:
        return jsonify({"error": "Missing upstream parameter"}), 400
    try:
        upstream = validate_arcgis_url(decode_upstream(enc))
        resp = _arcgis_upstream_get(upstream)
        if resp.status_code != 200:
            return jsonify({"error": f"Upstream TileJSON error: {resp.status_code}"}), resp.status_code
        tilejson = resp.json()
        if isinstance(tilejson, dict):
            _base = request.host_url.rstrip("/")
            tilejson = rewrite_tilejson(tilejson, upstream, base_url=_base)
        return jsonify(tilejson)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        return _json_500("ArcGIS TileJSON proxy error", exc=e)


@app.get("/tiles/arcgis/<int:z>/<int:x>/<int:y>.<ext>")
def arcgis_tile(z: int, x: int, y: int, ext: str):
    """
    Proxy for ArcGIS tiles. Supports API key authentication and composite layers.

    Supports two formats:
    1) Old format: service=World_Imagery (ibasemaps-api)
    2) New format: style=arcgis/outdoor (static-map-tiles-api)

    composite=... overlays a second service on top (old format only).
    """
    if not _require_user(request):
        return ("Unauthorized", 401)

    style = request.args.get("style")  # e.g. "arcgis/outdoor"
    service = request.args.get("service", "World_Imagery")
    composite = request.args.get("composite")

    try:
        # ---------------------------
        # NEW static basemap tiles API
        # ---------------------------
        if style:
            # Normalize style: remove leading slash if present
            # Frontend sends "arcgis/outdoor", API expects "arcgis/outdoor" (keep the prefix)
            style = style.lstrip("/")

            # Check if API key is configured (required for static-map-tiles-api)
            if not ARCGIS_API_KEY:
                import logging

                logger = logging.getLogger(__name__)
                logger.error("ARCGIS_API_KEY environment variable is not set!")
                return (
                    "ArcGIS API key not configured. The static-map-tiles-api requires an API key with "
                    "'premium:user:staticbasemaptiles' privilege. Please set ARCGIS_API_KEY environment variable.",
                    500,
                )

            base_url = "https://static-map-tiles-api.arcgis.com/arcgis/rest/services/" "static-basemap-tiles-service/v1"
            # Style path should include "arcgis/" prefix (e.g., "arcgis/navigation", "arcgis/outdoor")
            # ArcGIS uses {z}/{y}/{x} format (row/column), but Leaflet sends {z}/{x}/{y}
            # The route receives: /tiles/arcgis/{z}/{x}/{y}, so we swap x and y for ArcGIS
            tile_url = f"{base_url}/{style}/static/tile/{z}/{y}/{x}"

            # Add token as query parameter (API key must have 'premium:user:staticbasemaptiles' privilege)
            params = {"token": ARCGIS_API_KEY}
            tile_url += "?" + urlencode(params)

            # Log the request (without exposing full API key in logs)
            import logging

            logger = logging.getLogger(__name__)
            logger.info(
                f"ArcGIS static-map-tiles request: style={style}, z={z}, y={y}, x={x}, has_token={bool(ARCGIS_API_KEY)}, key_length={len(ARCGIS_API_KEY) if ARCGIS_API_KEY else 0}"
            )
            # Log first 10 chars of key for debugging (safe to expose)
            if ARCGIS_API_KEY:
                logger.info(f"API key preview: {ARCGIS_API_KEY[:10]}... (length: {len(ARCGIS_API_KEY)})")

            resp = requests.get(
                tile_url,
                headers={
                    "User-Agent": "scepmaps/1.0",
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Cache-Control": "max-age=3600",
                },
                timeout=10,
            )

            if resp.status_code != 200:
                # Enhanced error logging for 401/403 (authentication/authorization issues)
                error_msg = f"ArcGIS tile error: {resp.status_code}"

                # Try to parse JSON error response from ArcGIS
                try:
                    import json

                    error_json = resp.json()
                    if "error" in error_json:
                        error_details = error_json["error"]
                        error_msg += f" - {error_details.get('message', 'Unknown error')}"
                        if "details" in error_details:
                            error_msg += f" | Details: {error_details['details']}"
                except:
                    # If not JSON, try text
                    try:
                        error_body = resp.text[:500]
                        if error_body:
                            error_msg += f" - Response: {error_body}"
                    except:
                        pass

                # Log the actual URL being called (with token masked for security)
                masked_url = tile_url.replace(ARCGIS_API_KEY, "***MASKED***") if ARCGIS_API_KEY else tile_url
                logger.error(f"ArcGIS request failed - URL: {masked_url}")
                logger.error(
                    f"API key configured: {bool(ARCGIS_API_KEY)}, length: {len(ARCGIS_API_KEY) if ARCGIS_API_KEY else 0}"
                )

                if resp.status_code == 401:
                    error_msg += " | Possible causes: invalid/expired API key or missing 'premium:user:staticbasemaptiles' privilege"
                elif resp.status_code == 403:
                    error_msg += " | API key is valid but missing 'premium:user:staticbasemaptiles' privilege"

                logger.error(f"ArcGIS tile request failed: {error_msg}")

                # Return error to client
                return (error_msg, resp.status_code)

            content_type = resp.headers.get("Content-Type", "image/png")
            return send_file(io.BytesIO(resp.content), mimetype=content_type)

        # ---------------------------
        # OLD ibasemaps-api format
        # ---------------------------
        else:
            base_url = "https://ibasemaps-api.arcgis.com/arcgis/rest/services"

            base_service_url = f"{base_url}/{service}/MapServer/tile/{z}/{y}/{x}"
            params = {}
            if ARCGIS_API_KEY:
                params["token"] = ARCGIS_API_KEY
            if params:
                base_service_url += "?" + urlencode(params)

            resp = requests.get(
                base_service_url,
                headers={
                    "User-Agent": "scepmaps/1.0",
                    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                    "Cache-Control": "max-age=3600",
                },
                timeout=10,
            )
            if resp.status_code != 200:
                return (f"ArcGIS tile error: {resp.status_code}", resp.status_code)

            base_img = Image.open(io.BytesIO(resp.content)).convert("RGBA")

            # Composite overlay (optional)
            if composite:
                composite_url = f"{base_url}/{composite}/MapServer/tile/{z}/{y}/{x}"
                comp_params = {}
                if ARCGIS_API_KEY:
                    comp_params["token"] = ARCGIS_API_KEY
                if comp_params:
                    composite_url += "?" + urlencode(comp_params)

                comp_resp = requests.get(
                    composite_url,
                    headers={
                        "User-Agent": "scepmaps/1.0",
                        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                        "Cache-Control": "max-age=3600",
                    },
                    timeout=10,
                )
                if comp_resp.status_code == 200:
                    composite_img = Image.open(io.BytesIO(comp_resp.content)).convert("RGBA")
                    base_img = Image.alpha_composite(base_img, composite_img)

            output = io.BytesIO()
            base_img.save(output, format="PNG")
            output.seek(0)
            return send_file(output, mimetype="image/png")

    except Exception as e:
        return _http_500("ArcGIS proxy error", exc=e)


@app.route("/api/arcgis/style/<path:style_name>", methods=["GET"])
def arcgis_style_json(style_name: str):
    """
    Proxy for ArcGIS Basemap Styles API - returns style JSON for vector tile basemaps.
    Compatible with MapLibre GL / Mapbox Style Specification.

    style_name: e.g., 'oceans', 'streets', 'topographic', 'open/navigation-dark', etc.
    """
    if not _require_user(request):
        return jsonify({"error": "Unauthorized"}), 401

    import logging

    logger = logging.getLogger(__name__)

    # Log immediately to verify route is being hit
    logger.info(f"Style endpoint hit: style_name={style_name}, request.path={request.path}")

    if not ARCGIS_API_KEY:
        logger.error("ARCGIS_API_KEY not configured for style endpoint")
        return jsonify({"error": "ARCGIS_API_KEY not configured"}), 500

    try:
        # ArcGIS Basemap Styles API endpoint
        # Format: https://basemapstyles-api.arcgis.com/arcgis/rest/services/styles/v2/styles/{data_source}/{style}
        # For oceans: https://basemapstyles-api.arcgis.com/arcgis/rest/services/styles/v2/styles/arcgis/oceans

        # Map style names to ArcGIS style identifiers
        # Note: For oceans, we might need to use the item ID or a different endpoint
        # The basemapstyles-api might not have a direct "oceans" style
        # Let's try multiple approaches:

        # Map style names to ArcGIS style identifiers
        style_map = {
            "oceans": "arcgis/oceans",
            "ocean": "open/navigation-dark",  # Ocean button now uses Open Basemaps Navigation Dark
        }

        # Get the style path - if it's already a full path (e.g., "open/navigation-dark"), use it directly
        # Otherwise, look it up in the style_map or default to the input
        logger.info(f"Received style_name: {style_name}")

        if "/" in style_name:
            # Already a full path like "open/navigation-dark" or "arcgis/oceans"
            arcgis_style = style_name
            logger.info(f"Using full path directly: {arcgis_style}")
        else:
            arcgis_style = style_map.get(style_name.lower(), style_name)
            logger.info(f"Looked up in style_map: {arcgis_style}")

        # Ensure style has proper prefix if not already present
        if not arcgis_style.startswith("arcgis/") and not arcgis_style.startswith("open/"):
            arcgis_style = f"arcgis/{arcgis_style}"
            logger.info(f"Added arcgis/ prefix: {arcgis_style}")

        logger.info(f"Final arcgis_style: {arcgis_style}")

        # Try the basemapstyles-api first
        # Format: https://basemapstyles-api.arcgis.com/arcgis/rest/services/styles/v2/styles/{data_source}/{style}
        style_urls_to_try = []

        # For all styles, use basemapstyles-api v2 (this is the standard way to get vector tile style JSONs)
        style_urls_to_try.append(
            f"https://basemapstyles-api.arcgis.com/arcgis/rest/services/styles/v2/styles/{arcgis_style}"
        )

        # Legacy: For old "oceans" requests, also try VectorTileServer (but ocean now maps to navigation-dark)
        if style_name.lower() in ("oceans", "ocean") and "navigation-dark" not in arcgis_style:
            # Fallback for old oceans requests
            style_urls_to_try.append(
                f"https://basemaps.arcgis.com/arcgis/rest/services/World_Ocean_Base/VectorTileServer/resources/styles/root.json"
            )

        # For VectorTileServer, token might be passed differently
        # VectorTileServer typically doesn't require token for style JSON, but we'll include it
        params = {"token": ARCGIS_API_KEY} if ARCGIS_API_KEY else {}
        # Some endpoints might need f=json
        params_with_f = {"token": ARCGIS_API_KEY, "f": "json"} if ARCGIS_API_KEY else {"f": "json"}

        resp = None
        last_error = None

        for style_url in style_urls_to_try:
            try:
                # Try with f=json first for VectorTileServer, then without
                test_params = (
                    params_with_f if "VectorTileServer" in style_url or "sharing/rest" in style_url else params
                )
                logger.info(f"Trying ArcGIS style URL: {style_url} (style_name={style_name})")
                resp = requests.get(style_url, params=test_params, timeout=10)

                if resp.status_code == 200:
                    # Verify it's valid JSON
                    try:
                        test_json = resp.json()
                        if isinstance(test_json, dict):
                            logger.info(f"Successfully fetched style from: {style_url}")
                            break
                        else:
                            logger.warning(f"Response is not a valid style JSON dict from: {style_url}")
                            last_error = f"Invalid JSON format from {style_url}"
                    except:
                        logger.warning(f"Response is not valid JSON from: {style_url}")
                        last_error = f"Invalid JSON from {style_url}"
                else:
                    logger.warning(f"Style URL returned {resp.status_code}: {style_url}")
                    last_error = f"{resp.status_code}: {resp.text[:200] if resp.text else 'No response body'}"
            except Exception as e:
                logger.warning(f"Error trying style URL {style_url}: {e}")
                last_error = str(e)
                continue

        # If all URLs failed and this is the old oceans style, try constructing style JSON manually
        # (Note: ocean now maps to open/navigation-dark, so this is only for legacy requests)
        if (
            (not resp or resp.status_code != 200)
            and style_name.lower() in ("oceans", "ocean")
            and "navigation-dark" not in arcgis_style
        ):
            logger.warning("All style URLs failed for oceans, constructing style JSON manually using VectorTileServer")
            # Construct a MapLibre GL style JSON for World Ocean Base
            # Use the VectorTileServer endpoint directly
            # Format: https://basemaps.arcgis.com/arcgis/rest/services/World_Ocean_Base/VectorTileServer/tile/{z}/{y}/{x}
            vector_tile_base = (
                "https://basemaps.arcgis.com/arcgis/rest/services/World_Ocean_Base/VectorTileServer/tile/{z}/{y}/{x}"
            )
            vector_tile_url = vector_tile_base

            # Create a MapLibre GL style JSON compatible with ArcGIS VectorTileServer
            style_json = {
                "version": 8,
                "name": "ArcGIS World Ocean Base",
                "metadata": {"mapbox:autocomposite": False},
                "sources": {"esri-ocean": {"type": "vector", "tiles": [vector_tile_url], "minzoom": 0, "maxzoom": 22}},
                "sprite": "https://basemaps.arcgis.com/arcgis/rest/services/World_Ocean_Base/VectorTileServer/resources/sprites/sprite",
                "glyphs": "https://basemaps.arcgis.com/arcgis/rest/services/World_Ocean_Base/VectorTileServer/resources/fonts/{fontstack}/{range}.pbf",
                "layers": [{"id": "ocean-background", "type": "background", "paint": {"background-color": "#1e3a8a"}}],
            }

            # Try to get the actual style from VectorTileServer if possible
            try:
                vts_style_url = "https://basemaps.arcgis.com/arcgis/rest/services/World_Ocean_Base/VectorTileServer/resources/styles/root.json"
                vts_resp = _arcgis_upstream_get(vts_style_url)
                if vts_resp.status_code == 200:
                    vts_style = vts_resp.json()
                    logger.info("Successfully fetched style from VectorTileServer")
                    _base = request.host_url.rstrip("/")
                    return jsonify(rewrite_arcgis_style(vts_style, base_url=_base))
            except Exception as e:
                logger.warning(f"Failed to fetch VectorTileServer style, using fallback: {e}")

            logger.info("Using manually constructed style JSON for oceans")
            _base = request.host_url.rstrip("/")
            return jsonify(rewrite_arcgis_style(style_json, base_url=_base))

        if not resp or resp.status_code != 200:
            error_msg = f"All style URLs failed. Last error: {last_error}"
            logger.error(error_msg)
            return (
                jsonify(
                    {
                        "error": f"Failed to fetch style: {error_msg}",
                        "urls_attempted": style_urls_to_try,
                        "style_name": style_name,
                    }
                ),
                404,
            )

        # Return the style JSON with absolute proxy URLs so MapLibre workers can
        # construct Request objects (they reject root-relative paths).
        _base = request.host_url.rstrip("/")
        style_json = resp.json()
        style_json = rewrite_arcgis_style(style_json, base_url=_base)

        logger.info(f"Successfully fetched and processed style: {style_name}")
        return jsonify(style_json)

    except Exception as e:
        import logging

        logger = logging.getLogger(__name__)
        logger.error(f"Style proxy error: {e}", exc_info=True)
        return jsonify({"error": "Style proxy error"}), 500


@app.route("/api/arcgis/style/test", methods=["GET"])
def test_style_route():
    """Admin-only route probe."""
    admin = _require_admin(request)
    if not admin:
        return jsonify({"error": "Unauthorized"}), 401
    return jsonify({"message": "Style route is working", "route": "/api/arcgis/style/<path:style_name>"})


@app.get("/api/arcgis/status")
def arcgis_status():
    """Admin-only ArcGIS API key health check (no key material returned)."""
    admin = _require_admin(request)
    if not admin:
        return jsonify({"error": "Unauthorized"}), 401

    has_key = bool(ARCGIS_API_KEY)
    key_valid = False
    key_has_privilege = False
    test_error = None

    if has_key:
        try:
            test_url = "https://static-map-tiles-api.arcgis.com/arcgis/rest/services/static-basemap-tiles-service/v1/arcgis/navigation-night/static/tile/10/512/512"
            test_resp = requests.get(
                test_url,
                params={"token": ARCGIS_API_KEY},
                headers=arcgis_upstream_headers(),
                timeout=5,
            )

            if test_resp.status_code == 200:
                key_valid = True
                key_has_privilege = True
            elif test_resp.status_code == 401:
                key_valid = False
                test_error = "API key is invalid or expired (401)"
            elif test_resp.status_code == 403:
                key_valid = True
                key_has_privilege = False
                test_error = "API key is valid but missing 'premium:user:staticbasemaptiles' privilege"
            else:
                test_error = f"Unexpected status: {test_resp.status_code}"
        except Exception as e:
            test_error = f"Test request failed: {str(e)}"

    return jsonify(
        {
            "api_key_configured": has_key,
            "api_key_valid": key_valid,
            "api_key_has_privilege": key_has_privilege,
            "test_error": test_error,
            "note": "API key is used server-side only via tile/style proxies.",
        }
    )


# --- OpenAIP tile proxy ------------------------------------------------------

OPENAIP_KEY = os.getenv("OPENAIP_KEY")
_OAIP_SUBS = ["a", "b", "c"]


@app.get("/tiles/openaip/<int:z>/<int:x>/<int:y>.png")
def openaip_tile(z: int, x: int, y: int):
    if not _require_user(request):
        return ("Unauthorized", 401)
    if not OPENAIP_KEY:
        return ("OpenAIP key not configured on server", 404)
    try:
        sub = _OAIP_SUBS[(x + y + z) % len(_OAIP_SUBS)]
        url = f"https://{sub}.api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.png?apiKey={OPENAIP_KEY}"
        resp = requests.get(
            url,
            headers={
                "User-Agent": "scepmaps/1.0 (Playwright export)",
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                "Cache-Control": "no-cache",
            },
            timeout=15,
        )
        if resp.status_code != 200:
            return (f"Upstream error fetching OpenAIP: {resp.status_code}", resp.status_code)
        content_type = resp.headers.get("Content-Type", "image/png")
        return send_file(io.BytesIO(resp.content), mimetype=content_type)
    except Exception as e:
        return _http_500("OpenAIP proxy error", exc=e)


@app.get("/tiles/gbsouth/<int:z>/<int:x>/<int:y>.png")
def gbsouth_tile(z: int, x: int, y: int):
    """Serve pre-rendered GB South aviation chart tiles"""
    from pathlib import Path

    # Path to the pre-rendered tiles
    # In Docker, this is mounted at /app/tiles_gb_south
    # For local dev, check both locations
    docker_path = Path("/app/tiles_gb_south")
    local_path = Path("/home/rpol/scep/maps/tiles_gb_south")

    tiles_dir = docker_path if docker_path.exists() else local_path
    tile_path = tiles_dir / str(z) / str(x) / f"{y}.png"

    # Check if tile exists
    if not tile_path.exists():
        return ("Tile not found", 404)

    try:
        return send_file(str(tile_path), mimetype="image/png")
    except Exception as e:
        return _http_500("Error serving tile", exc=e)


# --- Auth and admin APIs -----------------------------------------------------


def _require_auth_with_quota(req, base: str, overlays):
    token = extract_bearer_token(req)
    if not token:
        raise PermissionError("Unauthorized")
    payload = verify_token(token)
    if not payload:
        raise PermissionError("Unauthorized")
    user = get_user_by_id(int(payload.get("uid", 0)))
    if not user:
        raise PermissionError("Unauthorized")

    # Permission logic:
    # - None/null: unrestricted access
    # - []: explicitly no access to anything
    # - [...]: whitelist of allowed items
    bases = user.get("allowed_bases")
    overs = user.get("allowed_overlays")

    # Check base layer permissions
    if bases is not None:  # Explicit permission list exists
        # Treat None/''/whitespace as unrestricted
        if isinstance(bases, str) and bases.strip() == "":
            bases = None
        if isinstance(bases, list):
            if len(bases) == 0:
                raise PermissionError("No base layers permitted")
            if base and base not in bases:
                raise PermissionError(f'Base layer "{base}" not permitted')

    # Check overlay permissions
    if overs is not None:  # Explicit permission list exists
        if isinstance(overs, str) and overs.strip() == "":
            overs = None
        if isinstance(overs, list):
            for k, v in (overlays or {}).items():
                if v:  # overlay is enabled
                    if len(overs) == 0:
                        raise PermissionError("No overlays permitted")
                    if k not in overs:
                        raise PermissionError(f'Overlay "{k}" not permitted')

    # Quotas — atomic check + insert so concurrent workers cannot race past limits.
    log_id = reserve_export_quota(
        user["id"],
        user["limit_day"],
        user["limit_week"],
        user["limit_month"],
        base,
        overlays,
    )
    return user, log_id


@app.post("/auth/login")
def login():
    data = request.get_json(force=True)
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")
    user, pwh = get_user_by_email(email)
    if not user or not pwh or not verify_password(password, pwh):
        activity.enrich(login_email=email, login_ok=False)
        return ({"error": "Invalid credentials"}, 401)
    activity.enrich(user=user, login_email=email, login_ok=True)
    token = mint_token_for_user(user)
    return {"token": token, "user": user}


@app.get("/auth/me")
def me():
    token = extract_bearer_token(request)
    if not token:
        return ({"error": "Unauthorized"}, 401)
    payload = verify_token(token)
    if not payload:
        return ({"error": "Unauthorized"}, 401)
    user = get_user_by_id(int(payload.get("uid", 0)))
    if not user:
        return ({"error": "Unauthorized"}, 401)
    activity.enrich(user=user)
    refreshed = mint_token_for_user(user)
    return {"user": user, "token": refreshed}


def _require_jwt_user(req):
    """Strict JWT auth for user-data APIs (unlike tile proxy _require_user)."""
    token = extract_bearer_token(req)
    if not token:
        return None
    payload = verify_token(token)
    if not payload:
        return None
    user = get_user_by_id(int(payload.get("uid", 0)))
    return user or None


def _looks_like_kml(text: str) -> bool:
    sample = (text or "")[:8000].lstrip().lower()
    if not sample:
        return False
    if "<kml" in sample:
        return True
    # Some exports wrap geometry without an early <kml> root tag.
    if sample.startswith("<?xml") and (
        "placemark" in sample
        or "document" in sample
        or "groundoverlay" in sample
        or "folder" in sample
        or "<gx:track" in sample
    ):
        return True
    return False


def _decode_text_bytes(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def _extract_kml_from_kmz(raw: bytes) -> str:
    """Return the primary KML document from a KMZ archive (images stay as relative hrefs)."""
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            names = [n for n in zf.namelist() if not n.endswith("/")]
            kml_name = next((n for n in names if n.lower().endswith("/doc.kml") or n.lower() == "doc.kml"), None)
            if not kml_name:
                kml_name = next((n for n in names if n.lower().endswith(".kml")), None)
            if not kml_name:
                raise ValueError("KMZ has no .kml document")
            return _decode_text_bytes(zf.read(kml_name))
    except zipfile.BadZipFile as e:
        raise ValueError("Invalid KMZ archive") from e


def _normalize_uploaded_kml(raw: bytes, filename: str) -> tuple[str, str]:
    """
    Accept .kml or .kmz bytes and return (kml_text, display_name).
    Prefer client-side KMZ expansion (images inlined); server KMZ path is a fallback.
    """
    name = (filename or "overlay.kml").strip() or "overlay.kml"
    lower = name.lower()
    is_kmz = lower.endswith(".kmz") or (len(raw) >= 2 and raw[:2] == b"PK" and not lower.endswith(".kml"))
    if is_kmz:
        content = _extract_kml_from_kmz(raw)
        if lower.endswith(".kmz"):
            name = name[:-4] + ".kml"
        elif not lower.endswith(".kml"):
            name = f"{name}.kml"
    else:
        content = _decode_text_bytes(raw)
        if not lower.endswith(".kml"):
            name = f"{name}.kml"
    return content, name[:120]


def _format_bytes(n: int) -> str:
    n = max(0, int(n))
    gb = 1024 * 1024 * 1024
    mb = 1024 * 1024
    if n >= gb:
        val = n / gb
        text = f"{val:.0f}" if val >= 10 else f"{val:.1f}".rstrip("0").rstrip(".")
        return f"{text} GB"
    if n >= mb:
        val = n / mb
        text = f"{val:.0f}" if val >= 10 else f"{val:.1f}".rstrip("0").rstrip(".")
        return f"{text} MB"
    if n >= 1024:
        return f"{n // 1024} KB"
    return f"{n} B"


@app.get("/api/kml")
def api_list_kml():
    user = _require_jwt_user(request)
    if not user:
        return ({"error": "Unauthorized"}, 401)
    activity.enrich(user=user, kml_action="list")
    uid = int(user["id"])
    items = list_user_kml(uid)
    used_bytes = sum_user_kml_bytes(uid)
    return {
        "items": items,
        "max_items": MAX_KML_PER_USER,
        "max_bytes": MAX_KML_BYTES,
        "max_storage_bytes": MAX_KML_STORAGE_BYTES,
        "used_bytes": used_bytes,
    }


@app.get("/api/kml/<int:kml_id>")
def api_get_kml(kml_id: int):
    user = _require_jwt_user(request)
    if not user:
        return ({"error": "Unauthorized"}, 401)
    row = get_user_kml(int(user["id"]), int(kml_id))
    if not row:
        return ({"error": "Not found"}, 404)
    activity.enrich(user=user, kml_action="get", kml_id=kml_id)
    return {
        "id": row["id"],
        "name": row["name"],
        "content": row["content"],
        "created_at": row["created_at"],
        "color": row.get("color", "#4de2ff"),
        "opacity": row.get("opacity", 0.65),
        "enabled": bool(row.get("enabled")),
    }


@app.post("/api/kml")
def api_create_kml():
    user = _require_jwt_user(request)
    if not user:
        return ({"error": "Unauthorized"}, 401)

    name = ""
    content = ""
    size_bytes = 0

    if request.files and "file" in request.files:
        f = request.files["file"]
        raw = f.read()
        size_bytes = len(raw)
        if size_bytes > MAX_KML_BYTES:
            return ({"error": f"File too large (max {_format_bytes(MAX_KML_BYTES)})"}, 400)
        try:
            content, name = _normalize_uploaded_kml(raw, f.filename or request.form.get("name") or "overlay.kml")
        except ValueError as e:
            return ({"error": str(e) or "Invalid KML/KMZ file"}, 400)
        size_bytes = len(content.encode("utf-8"))
        if request.form.get("name"):
            name = str(request.form.get("name")).strip()[:120] or name
    else:
        data = request.get_json(silent=True) or {}
        content = data.get("content") or ""
        name = (data.get("name") or "overlay.kml").strip()
        size_bytes = len(content.encode("utf-8"))
        if size_bytes > MAX_KML_BYTES:
            return ({"error": f"File too large (max {_format_bytes(MAX_KML_BYTES)})"}, 400)

    if not content or not _looks_like_kml(content):
        return ({"error": "Invalid KML file"}, 400)

    # Normalize name
    name = name[:120] or "overlay.kml"

    uid = int(user["id"])
    if count_user_kml(uid) >= MAX_KML_PER_USER:
        return ({"error": f"Limit of {MAX_KML_PER_USER} KML overlays reached"}, 400)

    used_bytes = sum_user_kml_bytes(uid)
    if used_bytes + size_bytes > MAX_KML_STORAGE_BYTES:
        remaining = max(0, MAX_KML_STORAGE_BYTES - used_bytes)
        return (
            {
                "error": (
                    f"KML storage limit of {_format_bytes(MAX_KML_STORAGE_BYTES)} reached "
                    f"({_format_bytes(remaining)} remaining)"
                )
            },
            400,
        )

    created = create_user_kml(uid, name, content, enabled=1)
    activity.enrich(user=user, kml_action="create", kml_id=created["id"], kml_name=name)
    return {"item": created}, 201


@app.patch("/api/kml/<int:kml_id>")
def api_patch_kml(kml_id: int):
    user = _require_jwt_user(request)
    if not user:
        return ({"error": "Unauthorized"}, 401)
    data = request.get_json(silent=True) or {}
    updated = update_user_kml(
        int(user["id"]),
        int(kml_id),
        name=data.get("name"),
        color=data.get("color"),
        opacity=data.get("opacity"),
        enabled=data.get("enabled"),
    )
    if not updated:
        return ({"error": "Not found"}, 404)
    activity.enrich(user=user, kml_action="patch", kml_id=kml_id)
    # Never return full content in patch response
    return {
        "item": {
            "id": updated["id"],
            "name": updated["name"],
            "created_at": updated["created_at"],
            "color": updated.get("color", "#4de2ff"),
            "opacity": updated.get("opacity", 0.65),
            "enabled": bool(updated.get("enabled")),
            "size_bytes": updated.get("size_bytes", 0),
        }
    }


@app.delete("/api/kml/<int:kml_id>")
def api_delete_kml(kml_id: int):
    user = _require_jwt_user(request)
    if not user:
        return ({"error": "Unauthorized"}, 401)
    ok = delete_user_kml(int(user["id"]), int(kml_id))
    if not ok:
        return ({"error": "Not found"}, 404)
    activity.enrich(user=user, kml_action="delete", kml_id=kml_id)
    return {"ok": True}


@app.post("/auth/preferences")
def update_preferences():
    """Update user's default map position, zoom, and layer/export preferences"""
    token = request.headers.get("Authorization", "")
    if token.startswith("Bearer "):
        token = token[len("Bearer ") :]
    payload = verify_token(token)
    if not payload:
        return ({"error": "Unauthorized"}, 401)

    user_id = int(payload.get("uid", 0))
    user = get_user_by_id(user_id)
    if not user:
        return ({"error": "Unauthorized"}, 401)

    data = request.get_json(force=True)
    default_lat = data.get("default_lat")
    default_lon = data.get("default_lon")
    default_zoom = data.get("default_zoom")
    default_base = data.get("default_base")
    default_overlays = data.get("default_overlays")
    default_system = data.get("default_system")
    default_quality = data.get("default_quality")
    default_units = data.get("default_units")
    density_opacity = data.get("density_opacity")
    density_border_color = data.get("density_border_color")
    density_border_hover_color = data.get("density_border_hover_color")
    favorite_maps = data.get("favorite_maps")
    favorite_overlays = data.get("favorite_overlays")

    # Validate inputs
    if default_lat is not None:
        default_lat = float(default_lat)
        if not (-90 <= default_lat <= 90):
            return ({"error": "Invalid latitude"}, 400)

    if default_lon is not None:
        default_lon = float(default_lon)
        if not (-180 <= default_lon <= 180):
            return ({"error": "Invalid longitude"}, 400)

    if default_zoom is not None:
        default_zoom = int(default_zoom)
        if not (0 <= default_zoom <= 18):
            return ({"error": "Invalid zoom level"}, 400)

    if default_base is not None:
        if default_base not in ["osm", "dark", "esri", "topo", "navigation", "night", "ocean", "shom", "ukho", "gbsouth"]:
            return ({"error": "Invalid base layer"}, 400)

    if default_overlays is not None:
        if not isinstance(default_overlays, list):
            return ({"error": "Invalid overlays format"}, 400)
        for overlay in default_overlays:
            if overlay not in ["seamarks", "openaip", "density", "history", "label"]:
                return ({"error": f"Invalid overlay: {overlay}"}, 400)

    if default_system is not None:
        if default_system not in ["UAS", "RADAR_overview", "RADAR_detailed"]:
            return ({"error": "Invalid system"}, 400)

    if default_quality is not None:
        if default_quality not in ["SD", "HD"]:
            return ({"error": "Invalid quality"}, 400)

    if default_units is not None:
        if default_units not in ["m", "km", "ft", "mi", "nm"]:
            return ({"error": "Invalid units"}, 400)

    if density_opacity is not None:
        density_opacity = float(density_opacity)
        if not (0 <= density_opacity <= 1):
            return ({"error": "Density opacity must be between 0 and 1"}, 400)

    # Validate color format (basic check for rgba format)
    if density_border_color is not None:
        if not isinstance(density_border_color, str) or len(density_border_color) > 50:
            return ({"error": "Invalid border color format"}, 400)

    if density_border_hover_color is not None:
        if not isinstance(density_border_hover_color, str) or len(density_border_hover_color) > 50:
            return ({"error": "Invalid hover border color format"}, 400)

    # Validate favorite maps/overlays (must be lists of strings, max 4 each)
    valid_bases = ["osm", "dark", "esri", "topo", "navigation", "night", "ocean", "shom", "ukho", "gbsouth"]
    valid_overlays = ["seamarks", "openaip", "density", "history", "label"]

    if favorite_maps is not None:
        if not isinstance(favorite_maps, list) or len(favorite_maps) > 4:
            return ({"error": "Invalid favorite maps (max 4)"}, 400)
        for fm in favorite_maps:
            if fm not in valid_bases:
                return ({"error": f"Invalid favorite map: {fm}"}, 400)

    if favorite_overlays is not None:
        if not isinstance(favorite_overlays, list) or len(favorite_overlays) > 4:
            return ({"error": "Invalid favorite overlays (max 4)"}, 400)
        for fo in favorite_overlays:
            if fo not in valid_overlays:
                return ({"error": f"Invalid favorite overlay: {fo}"}, 400)

    from db import update_user_preferences

    update_user_preferences(
        user_id,
        default_lat,
        default_lon,
        default_zoom,
        default_base,
        default_overlays,
        default_system,
        default_quality,
        default_units,
        density_opacity,
        density_border_color,
        density_border_hover_color,
        favorite_maps,
        favorite_overlays,
    )

    # Return updated user
    updated_user = get_user_by_id(user_id)
    changed_keys = [k for k in (
        "default_lat", "default_lon", "default_zoom", "default_base", "default_overlays",
        "default_system", "default_quality", "default_units", "density_opacity",
        "density_border_color", "density_border_hover_color", "favorite_maps", "favorite_overlays",
    ) if k in data]
    activity.enrich(
        user=updated_user,
        prefs_changed=changed_keys,
        default_lat=default_lat,
        default_lon=default_lon,
        default_zoom=default_zoom,
        default_base=default_base,
    )
    return {"user": updated_user, "message": "Preferences updated successfully"}


def _is_loopback_addr(addr: str | None) -> bool:
    if not addr:
        return False
    # gunicorn/nginx talk over IPv4 loopback in this container; accept IPv6 too.
    return addr == "127.0.0.1" or addr == "::1" or addr.startswith("127.")


def _require_user(req):
    """Return the authenticated user dict or None. Used to gate map-tile proxy routes.

    Auth rules:
    - Loopback callers without proxy headers (Playwright headless / server-side exporter
      hitting 127.0.0.1:5001) are treated as an internal service user. gunicorn is bound to
      127.0.0.1 only (supervisord.conf), so this is not reachable from other containers or
      the host network — and we still require loopback here so a future 0.0.0.0 bind cannot
      reopen an anonymous bypass.
    - All other requests (nginx → gunicorn always sets X-Real-IP / X-Forwarded-For) must
      carry a valid JWT as Bearer or '?t=' (Leaflet <img> tiles cannot send headers).
    """
    has_proxy_headers = bool(req.headers.get("X-Real-IP") or req.headers.get("X-Forwarded-For"))
    if not has_proxy_headers:
        if _is_loopback_addr(getattr(req, "remote_addr", None)):
            return {"id": 0, "email": "internal"}
        return None

    token = extract_bearer_token(req) or req.args.get("t")
    if not token:
        return None
    payload = verify_token(token)
    if not payload:
        return None
    return get_user_by_id(int(payload.get("uid", 0)))


def _require_admin(req):
    token = extract_bearer_token(req)
    if not token:
        return None
    payload = verify_token(token)
    if not payload:
        return None
    user = get_user_by_id(int(payload.get("uid", 0)))
    if not user or not user.get("is_admin"):
        return None
    return user


@app.get("/admin/users")
def admin_list_users():
    admin = _require_admin(request)
    if not admin:
        return ({"error": "Unauthorized"}, 401)
    activity.enrich(user=admin, admin_action="list_users")
    users = list_users()
    try:
        now = int(__import__("time").time())
        day = now - 86400
        week = now - 7 * 86400
        month = now - 30 * 86400
        for u in users:
            u["count_day"] = count_exports_since(u["id"], day)
            u["count_week"] = count_exports_since(u["id"], week)
            u["count_month"] = count_exports_since(u["id"], month)
            u["count_total"] = count_exports_since(u["id"], 0)
    except Exception:
        pass
    activity.enrich(users_count=len(users))
    return {"users": users}


@app.post("/admin/users")
def admin_create_user():
    admin = _require_admin(request)
    if not admin:
        return ({"error": "Unauthorized"}, 401)
    activity.enrich(user=admin, admin_action="create_user")
    data = request.get_json(force=True)
    email = data.get("email", "").strip().lower()
    name = data.get("name", "")
    is_admin = bool(data.get("is_admin", False))
    password = data.get("password", "")

    if not email or not password:
        return ({"error": "Missing email or password"}, 400)

    # Handle permissions: if not provided, default to unrestricted (None)
    allowed_bases = data.get("allowed_bases")
    allowed_overlays = data.get("allowed_overlays")
    allowed_tools = data.get("allowed_tools")

    # If explicitly provided as empty list, keep it as empty (restrictive)
    # If not provided or invalid, default to None (unrestricted)
    if not isinstance(allowed_bases, list):
        allowed_bases = None
    if not isinstance(allowed_overlays, list):
        allowed_overlays = None
    if not isinstance(allowed_tools, list):
        allowed_tools = None

    limit_day = int(data.get("limit_day", -1))
    limit_week = int(data.get("limit_week", -1))
    limit_month = int(data.get("limit_month", -1))

    try:
        uid = create_user(
            email,
            name,
            hash_password(password),
            is_admin,
            allowed_bases,
            allowed_overlays,
            allowed_tools,
            limit_day,
            limit_week,
            limit_month,
        )
        activity.enrich(
            target_email=email,
            target_is_admin=is_admin,
            target_new_id=uid,
        )
        return {"id": uid}
    except sqlite3.IntegrityError:
        return ({"error": "Email already exists"}, 409)


@app.put("/admin/users/<int:user_id>")
def admin_update_user(user_id: int):
    admin = _require_admin(request)
    if not admin:
        return ({"error": "Unauthorized"}, 401)
    activity.enrich(user=admin, admin_action="update_user", target_user_id=user_id)
    data = request.get_json(force=True)
    pw = data.get("password")
    # If arrays are provided but empty, treat as explicit empty (no access).
    # If omitted, leave unchanged by passing None.
    allowed_bases = data["allowed_bases"] if "allowed_bases" in data else None
    allowed_overlays = data["allowed_overlays"] if "allowed_overlays" in data else None
    allowed_tools = data["allowed_tools"] if "allowed_tools" in data else None

    update_user(
        user_id,
        name=data.get("name"),
        email=data.get("email"),
        password_hash=hash_password(pw) if pw else None,
        is_admin=data.get("is_admin"),
        allowed_bases=allowed_bases,
        allowed_overlays=allowed_overlays,
        allowed_tools=allowed_tools,
        limit_day=int(data["limit_day"]) if "limit_day" in data else None,
        limit_week=int(data["limit_week"]) if "limit_week" in data else None,
        limit_month=int(data["limit_month"]) if "limit_month" in data else None,
        fun=data.get("fun") if "fun" in data else None,
    )
    return {"ok": True}


@app.delete("/admin/users/<int:user_id>")
def admin_delete_user(user_id: int):
    admin = _require_admin(request)
    if not admin:
        return ({"error": "Unauthorized"}, 401)
    activity.enrich(user=admin, admin_action="delete_user", target_user_id=user_id)
    delete_user(user_id)
    return {"ok": True}


@app.post("/admin/users/<int:user_id>/reset-onboarding")
def admin_reset_user_onboarding(user_id: int):
    admin = _require_admin(request)
    if not admin:
        return ({"error": "Unauthorized"}, 401)
    activity.enrich(user=admin, admin_action="reset_onboarding", target_user_id=user_id)

    target_user = get_user_by_id(user_id)
    if not target_user:
        return ({"error": "User not found"}, 404)

    current_version = int(target_user.get("onboarding_reset_version") or 0)
    next_version = current_version + 1
    update_user(user_id, onboarding_reset_version=next_version)
    return {"ok": True, "onboarding_reset_version": next_version}


@app.get("/admin/stats")
def admin_stats():
    admin = _require_admin(request)
    if not admin:
        return ({"error": "Unauthorized"}, 401)
    activity.enrich(user=admin, admin_action="get_stats")

    try:
        stats = get_all_export_stats()
        return {"stats": stats}
    except Exception as e:
        return _json_500("Failed to get stats", exc=e)


@app.get("/admin/users/<int:user_id>/stats")
def admin_user_stats(user_id: int):
    admin = _require_admin(request)
    if not admin:
        return ({"error": "Unauthorized"}, 401)

    try:
        user = get_user_by_id(user_id)
        if not user:
            return ({"error": "User not found"}, 404)

        stats = get_user_export_stats(user_id)
        return {"user": user, "stats": stats}
    except Exception as e:
        return _json_500("Failed to get user stats", exc=e)


@app.get("/user/stats")
def user_stats():
    """Allow users to see their own export statistics"""
    token = request.headers.get("Authorization", "")
    if token.startswith("Bearer "):
        token = token[len("Bearer ") :]
    payload = verify_token(token)
    if not payload:
        return ({"error": "Unauthorized"}, 401)
    user = get_user_by_id(int(payload.get("uid", 0)))
    if not user:
        return ({"error": "Unauthorized"}, 401)

    try:
        stats = get_user_export_stats(user["id"])

        # Add current limits for user context
        now = int(__import__("time").time())
        day_start = now - 86400
        week_start = now - 7 * 86400
        month_start = now - 30 * 86400

        limits_status = {
            "day": {
                "limit": user["limit_day"],
                "used": stats["today"],
                "remaining": user["limit_day"] - stats["today"] if user["limit_day"] >= 0 else -1,
            },
            "week": {
                "limit": user["limit_week"],
                "used": stats["week"],
                "remaining": user["limit_week"] - stats["week"] if user["limit_week"] >= 0 else -1,
            },
            "month": {
                "limit": user["limit_month"],
                "used": stats["month"],
                "remaining": user["limit_month"] - stats["month"] if user["limit_month"] >= 0 else -1,
            },
        }

        activity.enrich(user=user, viewed_own_stats=True)
        return {"stats": stats, "limits": limits_status}
    except Exception as e:
        return _json_500("Failed to get stats", exc=e)


if __name__ == "__main__":
    # Run dev server
    # Use 0.0.0.0 for Docker compatibility, 127.0.0.1 for local dev
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", 5001))
    debug = os.getenv("FLASK_ENV") == "development"
    app.run(host=host, port=port, debug=debug)
