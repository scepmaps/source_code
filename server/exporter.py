import io
import math
from typing import Dict

import numpy as np
import rasterio
from PIL import Image
from rasterio.io import MemoryFile
from rasterio.transform import Affine
from rasterio.warp import Resampling, calculate_default_transform, reproject, transform_bounds
from tilers import (
    TILE_SIZE,
    choose_url,
    fetch_tile,
    lonlat_to_pixel,
    pixel_bounds_for_bbox,
    pixel_to_lonlat,
    tile_range_for_pixels,
)
from utils import bbox_4326_to_3857

# Compose base + overlays into an RGBA mosaic for a given bbox and zoom


def build_mosaic_rgba(bbox4326, zoom: int, base: str, overlays: Dict[str, bool]):
    left, top, right, bottom = pixel_bounds_for_bbox(bbox4326, zoom)
    tx_min, ty_min, tx_max, ty_max = tile_range_for_pixels(left, top, right, bottom)

    mosaic_w = (tx_max - tx_min + 1) * TILE_SIZE
    mosaic_h = (ty_max - ty_min + 1) * TILE_SIZE

    # Validate and normalize base layer
    base_key = (
        base
        if base in ("osm", "dark", "esri", "topo", "navigation", "night", "ocean", "shom", "ukho", "gbsouth")
        else "esri"
    )
    base_url = choose_url(base_key)

    # Create RGBA canvas
    canvas = Image.new("RGBA", (mosaic_w, mosaic_h))

    # Paste base tiles
    for ty in range(ty_min, ty_max + 1):
        for tx in range(tx_min, tx_max + 1):
            try:
                im = fetch_tile(zoom, tx, ty, base_url)
            except Exception:
                # Fallback: if base tile is missing/unavailable, try OSM tile
                if base_key in ("shom", "ukho", "gbsouth"):
                    try:
                        osm_url = choose_url("osm")
                        im = fetch_tile(zoom, tx, ty, osm_url)
                    except Exception:
                        im = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0))
                else:
                    im = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0))
            px = (tx - tx_min) * TILE_SIZE
            py = (ty - ty_min) * TILE_SIZE
            canvas.paste(im, (px, py))

    # OpenSeaMap overlay
    if overlays.get("seamarks"):
        osm_overlay = choose_url("openseamap")
        for ty in range(ty_min, ty_max + 1):
            for tx in range(tx_min, tx_max + 1):
                try:
                    im = fetch_tile(zoom, tx, ty, osm_overlay)
                    canvas.alpha_composite(im, ((tx - tx_min) * TILE_SIZE, (ty - ty_min) * TILE_SIZE))
                except Exception:
                    pass

    # after pasting base + (optionally) seamarks...
    if overlays.get("openaip"):
        try:
            overlay_url = choose_url("openaip")
        except RuntimeError:
            overlay_url = None  # no key/provider: skip gracefully
        if overlay_url:
            for ty in range(ty_min, ty_max + 1):
                for tx in range(tx_min, tx_max + 1):
                    try:
                        im = fetch_tile(zoom, tx, ty, overlay_url)
                        canvas.alpha_composite(im, ((tx - tx_min) * TILE_SIZE, (ty - ty_min) * TILE_SIZE))
                    except Exception:
                        pass

    # Crop to exact bbox pixels inside the mosaic
    crop_left = int(round(left - tx_min * TILE_SIZE))
    crop_top = int(round(top - ty_min * TILE_SIZE))
    crop_right = int(round(right - tx_min * TILE_SIZE))
    crop_bottom = int(round(bottom - ty_min * TILE_SIZE))

    cropped = canvas.crop((crop_left, crop_top, crop_right, crop_bottom))

    # Compute exact bbox of the cropped pixels aligned to integer pixel grid
    # Use rounded pixel coordinates to match the actual crop applied above
    exact_left_px = int(round(left))
    exact_top_px = int(round(top))
    exact_right_px = int(round(right))
    exact_bottom_px = int(round(bottom))
    west, north = pixel_to_lonlat(exact_left_px, exact_top_px, zoom)
    east, south = pixel_to_lonlat(exact_right_px, exact_bottom_px, zoom)
    exact_bbox4326 = (min(west, east), min(south, north), max(west, east), max(south, north))

    return cropped, exact_bbox4326


MAX_TILE_COUNT = 400  # limit tiles per request to avoid huge renders


def _tile_count_for(bbox4326, zoom: int) -> int:
    left, top, right, bottom = pixel_bounds_for_bbox(bbox4326, zoom)
    tx_min, ty_min, tx_max, ty_max = tile_range_for_pixels(left, top, right, bottom)
    return max(0, (tx_max - tx_min + 1)) * max(0, (ty_max - ty_min + 1))


def _choose_safe_zoom(bbox4326, zoom: int) -> int:
    z = int(zoom)
    while z > 0 and _tile_count_for(bbox4326, z) > MAX_TILE_COUNT:
        z -= 1
    return z


def _auto_utm_epsg_for_bbox(bbox4326) -> str:
    lon = (bbox4326[0] + bbox4326[2]) / 2.0
    lat = (bbox4326[1] + bbox4326[3]) / 2.0
    zone = int((lon + 180) // 6) + 1
    return f"EPSG:{32600 + zone}" if lat >= 0 else f"EPSG:{32700 + zone}"


def export_geotiff(
    bbox4326,
    zoom: int,
    width: int,
    height: int,
    base: str,
    overlays: Dict[str, bool],
    out_crs: str = "EPSG:4326",
    system: str | None = None,
) -> bytes:
    import logging

    logger = logging.getLogger(__name__)

    logger.info(
        f"[Export] export_geotiff() called: bbox={bbox4326}, zoom={zoom}, width={width}, height={height}, base={base}, overlays={overlays}, out_crs={out_crs}, system={system}"
    )

    # Reduce zoom if too many tiles to fetch
    use_zoom = _choose_safe_zoom(bbox4326, zoom)
    if use_zoom != zoom:
        logger.info(f"[Export] Zoom reduced from {zoom} to {use_zoom} to stay within tile limit")

    # Build mosaic at native pixel size; avoid pre-resizing before georeferencing.
    # Resampling will be done during reprojection to keep pixel centers aligned.
    logger.info(f"[Export] Building mosaic at zoom {use_zoom}...")
    base_mosaic, exact_bbox4326 = build_mosaic_rgba(bbox4326, use_zoom, base, overlays)
    mosaic = base_mosaic
    logger.info(f"[Export] Mosaic built: size={mosaic.size}, exact_bbox={exact_bbox4326}")

    # Source georeference in EPSG:3857 based on exact bbox and native mosaic size
    xmin, ymin, xmax, ymax = bbox_4326_to_3857(exact_bbox4326)
    src_w, src_h = mosaic.size
    xres = (xmax - xmin) / src_w
    yres = (ymax - ymin) / src_h
    transform3857 = Affine(xres, 0, xmin, 0, -yres, ymax)

    # Create in-memory GeoTIFF in 3857, then optionally reproject to out_crs/system
    arr = np.array(mosaic)  # H x W x 4 (native size)
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
            # Set RGBA color interpretation if desired

        # Determine target CRS and desired pixel size from system
        target_crs = out_crs
        pixel_size_m = None
        force_epsg = None
        if system:
            if system in ("RADAR_overview", "RADAR_detailed"):
                # Enforce EPSG:32631 as requested
                target_crs = "EPSG:32631"
                pixel_size_m = 25 if system == "RADAR_overview" else 5
                logger.info(
                    f"[Export] RADAR system detected: {system}, target_crs={target_crs}, pixel_size={pixel_size_m}m"
                )

            # Re-open to reproject/resample if needed
            with mem.open() as src:
                # If staying in 3857 and native size matches request, return as-is
                if target_crs == "EPSG:3857" and src.width == width and src.height == height:
                    logger.info(f"[Export] No reprojection needed (staying in EPSG:3857, size matches)")
                    return mem.read()
                # Otherwise reproject/resample to target CRS and dimensions
                logger.info(f"[Export] Reprojecting to {target_crs}...")
                if pixel_size_m is not None:
                    # compute bounds in target CRS
                    left, bottom, right, top = transform_bounds(src.crs, target_crs, *src.bounds)
                    # align to 25m/5m grid: north-up, origin snapped to grid
                    snapped_left = math.floor(left / pixel_size_m) * pixel_size_m
                    snapped_top = math.ceil(top / pixel_size_m) * pixel_size_m
                    snapped_right = math.ceil(right / pixel_size_m) * pixel_size_m
                    snapped_bottom = math.floor(bottom / pixel_size_m) * pixel_size_m
                    out_width = max(1, int(round((snapped_right - snapped_left) / pixel_size_m)))
                    out_height = max(1, int(round((snapped_top - snapped_bottom) / pixel_size_m)))
                    dst_width, dst_height = out_width, out_height
                    # Rotation 0, meters units (EPSG:32631), exact pixel size
                    dst_transform = Affine(pixel_size_m, 0, snapped_left, 0, -pixel_size_m, snapped_top)
                else:
                    # Reproject to target CRS using requested output dimensions (SD/HD sizing)
                    left, bottom, right, top = transform_bounds(src.crs, target_crs, *src.bounds)
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
                        crs=target_crs,
                        transform=dst_transform,
                    ) as dst:
                        for i in range(1, 5):
                            reproject(
                                source=rasterio.band(src, i),
                                destination=rasterio.band(dst, i),
                                src_transform=src.transform,
                                src_crs=src.crs,
                                dst_transform=dst.transform,
                                dst_crs=target_crs,
                                resampling=(Resampling.nearest if pixel_size_m is not None else Resampling.lanczos),
                            )
                    return mem2.read()
