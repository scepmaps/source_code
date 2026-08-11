"""
SCEPMAPS activity emitter — stdout transport.

Writes one structured JSON line per significant event to stdout.
Every line is prefixed with SCEPMAPS_ACTIVITY: so it can be isolated
from regular Flask/Gunicorn log output by any external reader.

Contract:
  scepmaps writes → stdout → supervisord / docker logs → any observer

This module has no knowledge of whatchman, its location, or any shared
filesystem. It imports nothing from whatchman. If nothing is reading the
stream, events are simply discarded by the OS. scepmaps is unaffected.

Schema version: 1

Typical event (one JSON line on stdout):
  SCEPMAPS_ACTIVITY: {"v":1,"req_id":"a3f8c2e10b1d","ts":"2026-06-09T19:53:00Z",
    "category":"export","method":"POST","path":"/export","ip":"82.12.x.x",
    "status":200,"ok":true,"duration_ms":8420,"bytes_out":4200000,
    "user_id":3,"email":"alice@example.com",
    "detail":{"export_type":"tile","base":"esri","zoom":12,
              "width":2048,"height":2048,"crs":"EPSG:4326",
              "overlays":{"openaip":true},"bytes_produced":4200000,
              "bbox":[-1.2,43.1,-0.8,43.4],
              "bbox_area_km2":1340.2,"bbox_center":[-1.0,43.25]}}
"""

import json
import logging
import math
import os
import sys
import threading
import time
import uuid
from datetime import datetime, timezone

# ── Dedicated stdout logger ───────────────────────────────────────────────────
# Not propagated to the root logger so these lines don't double-print.
_log = logging.getLogger("scepmaps.activity")
_log.setLevel(logging.INFO)
_log.propagate = False
_h = logging.StreamHandler(sys.stdout)
_h.setFormatter(logging.Formatter("%(message)s"))
_log.addHandler(_h)

# ── Config via environment ────────────────────────────────────────────────────
# Set ACTIVITY_TILE_SAMPLE_RATE=1 to emit every tile event (high volume!).
_TILE_SAMPLE_RATE = max(1, int(os.getenv("ACTIVITY_TILE_SAMPLE_RATE", "50")))

# ACTIVITY_ENABLED=0 to silence all activity output (e.g. in tests).
_ENABLED = os.getenv("ACTIVITY_ENABLED", "1").strip().lower() not in ("0", "false", "no")

# ── Route classification ──────────────────────────────────────────────────────
_EXPORT_PATHS = frozenset({"/export", "/export_headless", "/export_hgt", "/export_hgt_map_tiff"})
_AUTH_PATHS   = frozenset({"/auth/login", "/auth/me", "/auth/preferences", "/auth/request-access", "/auth/change-password", "/auth/feedback"})
_USER_PATHS   = frozenset({"/user/stats"})
_TILE_PREFIX  = "/tiles/"
_ADMIN_PREFIX = "/admin/"
_SKIP_PREFIXES = ("/static", "/_", "/favicon", "/login.html", "/admin.html", "/request-access.html")
_HEALTH_PATHS = frozenset({"/health"})


def _classify(path: str) -> str:
    if path in _EXPORT_PATHS:           return "export"
    if path in _AUTH_PATHS:             return "auth"
    if path in _USER_PATHS:             return "user"
    if path in _HEALTH_PATHS:           return "health"
    if path.startswith(_ADMIN_PREFIX):  return "admin"
    if path.startswith(_TILE_PREFIX):   return "tile"
    return "other"


def _should_skip(path: str, category: str) -> bool:
    if category == "health":
        return True
    return any(path.startswith(p) for p in _SKIP_PREFIXES)


# ── Geo helpers (exported so app.py can call them before enriching) ───────────
def bbox_area_km2(bbox) -> float | None:
    """
    Rough surface area in km² for a WGS84 bbox [W, S, E, N].
    Uses a mid-latitude cosine correction for longitude distortion.
    """
    try:
        w, s, e, n = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
        lat_mid = math.radians((s + n) / 2.0)
        km_per_deg_lon = 111.320 * math.cos(lat_mid)
        km_per_deg_lat = 111.320
        return round(abs(e - w) * km_per_deg_lon * abs(n - s) * km_per_deg_lat, 1)
    except Exception:
        return None


def bbox_center(bbox) -> list | None:
    """[lon, lat] centroid of a WGS84 bbox."""
    try:
        w, s, e, n = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
        return [round((w + e) / 2.0, 5), round((s + n) / 2.0, 5)]
    except Exception:
        return None


def bbox_corners(bbox) -> dict | None:
    """Individual W/S/E/N corners for easier downstream indexing."""
    try:
        w, s, e, n = float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])
        return {
            "bbox_w": round(w, 5),
            "bbox_s": round(s, 5),
            "bbox_e": round(e, 5),
            "bbox_n": round(n, 5),
        }
    except Exception:
        return None


def overlay_names(overlays) -> list | None:
    """Active overlay keys from an overlays dict."""
    if not overlays or not isinstance(overlays, dict):
        return None
    try:
        names = sorted(k for k, v in overlays.items() if v)
        return names or None
    except Exception:
        return None


def ua_family(user_agent: str | None) -> str | None:
    """Lightweight client family label from User-Agent (no external deps)."""
    if not user_agent:
        return None
    ua = user_agent.lower()
    if "edg/" in ua or "edge/" in ua:
        browser = "Edge"
    elif "chrome/" in ua and "chromium" not in ua:
        browser = "Chrome"
    elif "firefox/" in ua:
        browser = "Firefox"
    elif "safari/" in ua and "chrome" not in ua:
        browser = "Safari"
    elif "curl/" in ua:
        browser = "curl"
    else:
        browser = "Other"

    if "windows" in ua:
        os_name = "Windows"
    elif "mac os" in ua or "macintosh" in ua:
        os_name = "macOS"
    elif "android" in ua:
        os_name = "Android"
    elif "iphone" in ua or "ipad" in ua:
        os_name = "iOS"
    elif "linux" in ua:
        os_name = "Linux"
    else:
        os_name = "Unknown"
    return f"{browser}/{os_name}"


# ── Per-request thread-local state ────────────────────────────────────────────
# Gunicorn sync workers: one request per thread at a time — thread-local is safe.
# Each worker resets state at the start of every request via on_request_start().
_local = threading.local()


# ── Public Flask hooks ────────────────────────────────────────────────────────
def on_request_start():
    """
    Register as @app.before_request.

    Captures the request envelope (method, path, IP, headers).
    Sets _local.skip=True for paths that should never emit events.
    Applies tile sampling.
    """
    if not _ENABLED:
        _local.skip = True
        return
    try:
        from flask import request
        import random

        path     = request.path
        category = _classify(path)

        if _should_skip(path, category):
            _local.skip = True
            return

        # Sample high-volume tile traffic.
        if category == "tile" and random.randint(1, _TILE_SAMPLE_RATE) != 1:
            _local.skip = True
            return

        _local.skip     = False
        _local.t0       = time.monotonic()
        _local.req_id   = uuid.uuid4().hex[:12]
        _local.category = category
        _local.detail   = {}
        _local.user_id  = None
        _local.email    = None

        # Capture everything available at the point the request arrives,
        # before any route handler logic runs.
        forwarded_for = request.headers.get("X-Forwarded-For", "")
        client_ip = forwarded_for.split(",")[0].strip() if forwarded_for else request.remote_addr

        ua = request.user_agent.string or None
        _local.envelope = {
            "v":               1,
            "req_id":          _local.req_id,
            "ts":              datetime.now(timezone.utc).isoformat(),
            "category":        category,
            "method":          request.method,
            "path":            path,
            "query":           request.query_string.decode("utf-8", errors="replace") or None,
            "ip":              client_ip,
            "user_agent":      ua,
            "client_family":   ua_family(ua),
            "accept_language": request.headers.get("Accept-Language") or None,
            "origin":          request.headers.get("Origin") or None,
            "content_type":    request.content_type or None,
            "content_length":  request.content_length,
            "referer":         request.referrer or None,
        }
    except Exception:
        _local.skip = True


def enrich(user=None, **kwargs):
    """
    Attach interpreted context from within a route handler.

    Call this after the handler has parsed the request body and resolved
    authentication — i.e. after the backend has interpreted the data.

    Args:
        user:   user dict from _require_auth_* or get_user_by_* (None = anonymous)
        kwargs: arbitrary key/value pairs merged verbatim into the detail block.
                None values are omitted to keep events compact.

    Safe to call multiple times in the same request — kwargs are merged.
    Silently ignored if the request is being skipped (tile sample, health, etc.).
    """
    try:
        if getattr(_local, "skip", True):
            return
        if user:
            _local.user_id = user.get("id")
            _local.email   = user.get("email")
            if "user_is_admin" not in _local.detail:
                _local.detail["user_is_admin"] = bool(user.get("is_admin"))

        # Auto-derive common export/geo fields when handlers pass raw params.
        if "bbox" in kwargs and kwargs["bbox"]:
            bbox = kwargs["bbox"]
            kwargs.setdefault("bbox_area_km2", bbox_area_km2(bbox))
            kwargs.setdefault("bbox_center", bbox_center(bbox))
            corners = bbox_corners(bbox)
            if corners:
                kwargs.update({k: v for k, v in corners.items() if k not in kwargs})
        if "overlays" in kwargs and kwargs["overlays"] and "overlay_names" not in kwargs:
            kwargs["overlay_names"] = overlay_names(kwargs["overlays"])
        width = kwargs.get("width")
        height = kwargs.get("height")
        if width and height and "megapixels" not in kwargs:
            try:
                kwargs["megapixels"] = round(int(width) * int(height) / 1_000_000, 2)
            except Exception:
                pass
        if "authenticated" not in kwargs:
            kwargs["authenticated"] = user is not None

        _local.detail.update({k: v for k, v in kwargs.items() if v is not None})
    except Exception:
        pass


def on_request_end(response):
    """
    Register as @app.after_request.

    Assembles the final event from envelope + enriched detail + response metadata
    and emits it. Returns response unchanged.

    This is the "before info is sent to users" tap point: after_request fires
    after the handler returns but before the response bytes leave the process.
    """
    try:
        if getattr(_local, "skip", True):
            return response

        event = {
            **_local.envelope,
            # ── Response ──────────────────────────────────────────────────────
            "status":        response.status_code,
            "ok":            response.status_code < 400,
            "duration_ms":   round((time.monotonic() - _local.t0) * 1000, 1),
            "bytes_out":     response.content_length,
            "mime_out":      response.content_type,
            # ── Resolved identity ─────────────────────────────────────────────
            "authenticated": _local.user_id is not None,
            "user_id":       _local.user_id,
            "email":         _local.email,
            # ── Handler-level context ─────────────────────────────────────────
            "detail":        _local.detail or None,
        }
        _emit(event)
    except Exception:
        pass
    return response


# ── Internal emit ─────────────────────────────────────────────────────────────
def _emit(event: dict):
    """
    Write one JSON line to stdout with a fixed prefix.

    The prefix SCEPMAPS_ACTIVITY: makes events grep-able in mixed log streams
    and lets a tail-based reader filter without parsing every line.

    json.dumps uses default=str so datetimes, Paths, etc. never raise.
    """
    try:
        line = "SCEPMAPS_ACTIVITY: " + json.dumps(event, default=str, separators=(",", ":"))
        _log.info(line)
    except Exception:
        pass
