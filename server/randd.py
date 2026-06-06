import os
import shutil
import threading
import time
from pathlib import Path

from db import DB_PATH, get_all_export_stats

APP_START_TIME = time.time()


def _format_bytes(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024**2:
        return f"{num_bytes / 1024:.1f} KB"
    if num_bytes < 1024**3:
        return f"{num_bytes / 1024**2:.1f} MB"
    return f"{num_bytes / 1024**3:.2f} GB"


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    try:
        for entry in path.rglob("*"):
            if entry.is_file():
                try:
                    total += entry.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _disk_usage(path: Path) -> dict:
    try:
        usage = shutil.disk_usage(path)
        used_pct = round((usage.used / usage.total) * 100, 1) if usage.total else 0
        return {
            "path": str(path),
            "total_bytes": usage.total,
            "used_bytes": usage.used,
            "free_bytes": usage.free,
            "used_percent": used_pct,
            "total": _format_bytes(usage.total),
            "used": _format_bytes(usage.used),
            "free": _format_bytes(usage.free),
        }
    except OSError:
        return {
            "path": str(path),
            "total_bytes": 0,
            "used_bytes": 0,
            "free_bytes": 0,
            "used_percent": 0,
            "total": "n/a",
            "used": "n/a",
            "free": "n/a",
        }


def _memory_info() -> dict:
    info = {
        "total_bytes": None,
        "available_bytes": None,
        "used_bytes": None,
        "used_percent": None,
        "total": "n/a",
        "available": "n/a",
        "used": "n/a",
    }
    meminfo_path = Path("/proc/meminfo")
    if not meminfo_path.exists():
        return info

    values = {}
    try:
        for line in meminfo_path.read_text().splitlines():
            key, _, value = line.partition(":")
            if not value:
                continue
            values[key.strip()] = int(value.strip().split()[0]) * 1024
    except OSError:
        return info

    total = values.get("MemTotal")
    available = values.get("MemAvailable")
    if total is None or available is None:
        return info

    used = max(total - available, 0)
    used_pct = round((used / total) * 100, 1) if total else 0
    info.update(
        {
            "total_bytes": total,
            "available_bytes": available,
            "used_bytes": used,
            "used_percent": used_pct,
            "total": _format_bytes(total),
            "available": _format_bytes(available),
            "used": _format_bytes(used),
        }
    )
    return info


def _load_average() -> dict:
    try:
        one, five, fifteen = os.getloadavg()
        return {"1m": round(one, 2), "5m": round(five, 2), "15m": round(fifteen, 2)}
    except (AttributeError, OSError):
        return {"1m": None, "5m": None, "15m": None}


def _provider_status() -> dict:
    def configured(name: str) -> bool:
        return bool(os.getenv(name, "").strip())

    return {
        "openaip": configured("OPENAIP_KEY"),
        "arcgis": configured("ARCGIS_API_KEY"),
        "ukho": configured("UKHO_SUBSCRIPTION_KEY") or configured("UKHO_WMS_URL"),
        "shom": configured("SHOM_REFERER"),
    }


def _database_info() -> dict:
    exists = DB_PATH.exists()
    size_bytes = DB_PATH.stat().st_size if exists else 0
    return {
        "path": str(DB_PATH),
        "exists": exists,
        "size_bytes": size_bytes,
        "size": _format_bytes(size_bytes),
    }


def get_randd_data() -> dict:
    server_root = Path(__file__).parent
    data_dir = server_root / "data"
    exports_dir = Path(os.getenv("EXPORTS_DIR", "/app/exports"))

    uptime_seconds = int(time.time() - APP_START_TIME)
    export_stats = get_all_export_stats()

    return {
        "timestamp": int(time.time()),
        "uptime_seconds": uptime_seconds,
        "uptime": _format_uptime(uptime_seconds),
        "environment": os.getenv("FLASK_ENV", "production"),
        "process": {
            "pid": os.getpid(),
            "threads": threading.active_count(),
            "load_average": _load_average(),
        },
        "memory": _memory_info(),
        "disk": {
            "root": _disk_usage(Path("/")),
            "data": _disk_usage(data_dir),
            "exports": _disk_usage(exports_dir),
        },
        "storage": {
            "data_dir_bytes": _dir_size(data_dir),
            "data_dir": _format_bytes(_dir_size(data_dir)),
            "exports_dir_bytes": _dir_size(exports_dir),
            "exports_dir": _format_bytes(_dir_size(exports_dir)),
        },
        "database": _database_info(),
        "exports": export_stats,
        "providers": _provider_status(),
        "health": {
            "database": DB_PATH.parent.exists(),
            "exports_dir": exports_dir.exists(),
            "status": "ok",
        },
    }


def _format_uptime(seconds: int) -> str:
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours:
        parts.append(f"{hours}h")
    if minutes:
        parts.append(f"{minutes}m")
    parts.append(f"{secs}s")
    return " ".join(parts)
