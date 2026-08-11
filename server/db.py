import json
import os
import sqlite3
import time
from pathlib import Path

# Default to data directory (persisted volume in Docker) or fallback to server directory
default_db_path = str(Path(__file__).parent / "data" / "users.db")
DB_PATH = Path(os.getenv("USERS_DB_PATH", default_db_path))


def _get_conn():
    # timeout + busy_timeout let concurrent gunicorn workers wait on write locks
    # instead of raising "database is locked" during quota reservations.
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.Error:
        pass
    return conn


def init_db():
    # Ensure data directory exists
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            name TEXT,
            password_hash TEXT NOT NULL,
            is_admin INTEGER NOT NULL DEFAULT 0,
            allowed_bases TEXT NOT NULL,
            allowed_overlays TEXT NOT NULL,
            allowed_tools TEXT NOT NULL,
            limit_day INTEGER NOT NULL DEFAULT -1,
            limit_week INTEGER NOT NULL DEFAULT -1,
            limit_month INTEGER NOT NULL DEFAULT -1,
            default_lat REAL,
            default_lon REAL,
            default_zoom INTEGER,
            default_base TEXT,
            default_overlays TEXT,
            default_system TEXT,
            default_quality TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS export_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            ts INTEGER NOT NULL,
            base TEXT,
            overlays TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    conn.commit()

    # Migration: Add default position/view columns if they don't exist
    try:
        cur.execute("ALTER TABLE users ADD COLUMN default_lat REAL")
        cur.execute("ALTER TABLE users ADD COLUMN default_lon REAL")
        cur.execute("ALTER TABLE users ADD COLUMN default_zoom INTEGER")
        conn.commit()
    except Exception:
        # Columns already exist
        pass

    # Migration: Add default layer/export preference columns if they don't exist
    try:
        cur.execute("ALTER TABLE users ADD COLUMN default_base TEXT")
        cur.execute("ALTER TABLE users ADD COLUMN default_overlays TEXT")
        cur.execute("ALTER TABLE users ADD COLUMN default_system TEXT")
        cur.execute("ALTER TABLE users ADD COLUMN default_quality TEXT")
        conn.commit()
    except Exception:
        # Columns already exist
        pass

    # Migration: Add tools permissions if it doesn't exist
    try:
        cur.execute("ALTER TABLE users ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT ''")
        conn.commit()
    except Exception:
        pass

    # Migration: Add fun property if it doesn't exist
    try:
        cur.execute("ALTER TABLE users ADD COLUMN fun INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    except Exception:
        # Column already exists
        pass

    # Migration: Add default_units if it doesn't exist
    try:
        cur.execute("ALTER TABLE users ADD COLUMN default_units TEXT")
        conn.commit()
    except Exception:
        pass

    # Migration: Add density_opacity preference if it doesn't exist
    try:
        cur.execute("ALTER TABLE users ADD COLUMN density_opacity REAL DEFAULT 0.65")
        conn.commit()
    except Exception:
        pass

    # Migration: Add density border color preferences
    try:
        cur.execute("ALTER TABLE users ADD COLUMN density_border_color TEXT DEFAULT 'rgba(255,255,255,0.2)'")
        cur.execute("ALTER TABLE users ADD COLUMN density_border_hover_color TEXT DEFAULT 'rgba(0,0,0,0.9)'")
        conn.commit()
    except Exception:
        pass

    # Migration: Add favorite buttons preferences
    try:
        cur.execute("ALTER TABLE users ADD COLUMN favorite_maps TEXT")
        cur.execute("ALTER TABLE users ADD COLUMN favorite_overlays TEXT")
        conn.commit()
    except Exception:
        pass

    # Migration: Add onboarding reset version for admin-triggered tour replay
    try:
        cur.execute("ALTER TABLE users ADD COLUMN onboarding_reset_version INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    except Exception:
        pass

    # Sanitize any legacy rows where permissions were stored as '[]' JSON instead of unrestricted
    try:
        cur.execute("UPDATE users SET allowed_bases = '' WHERE allowed_bases = '[]'")
        cur.execute("UPDATE users SET allowed_overlays = '' WHERE allowed_overlays = '[]'")
        conn.commit()
    except Exception:
        pass

    # Migration: ensure OSM Dark is present for users who already have OSM in an explicit whitelist
    try:
        cur.execute("SELECT id, allowed_bases FROM users WHERE allowed_bases IS NOT NULL AND allowed_bases != ''")
        rows = cur.fetchall()
        for row in rows:
            raw = row["allowed_bases"]
            try:
                bases = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(bases, list):
                continue
            if "osm" in bases and "dark" not in bases:
                osm_idx = bases.index("osm")
                bases.insert(osm_idx + 1, "dark")
                cur.execute(
                    "UPDATE users SET allowed_bases = ? WHERE id = ?",
                    (json.dumps(bases), row["id"]),
                )
        conn.commit()
    except Exception:
        pass

    # Migration: tools ACL is hgt/draw/kml/density.
    # - Move density from overlays → tools (preserve who already had it)
    # - Keep draw/kml for users who previously always had them
    # - Drop ruler/box from tools (always available in UI, not ACL)
    try:
        valid_tools = ("hgt", "draw", "kml", "density")
        always_on_tools = ("draw", "kml")  # historically ungated
        drop_tools = {"ruler", "box"}

        cur.execute(
            "SELECT id, is_admin, allowed_overlays, allowed_tools FROM users"
        )
        rows = cur.fetchall()
        for row in rows:
            # Parse overlays
            raw_over = row["allowed_overlays"] or ""
            if raw_over == "":
                overlays = None
            else:
                try:
                    overlays = json.loads(raw_over)
                except (json.JSONDecodeError, TypeError):
                    overlays = None
                if not isinstance(overlays, list):
                    overlays = None

            # Parse tools
            raw_tools = row["allowed_tools"] or ""
            if raw_tools == "":
                tools = None
            else:
                try:
                    tools = json.loads(raw_tools)
                except (json.JSONDecodeError, TypeError):
                    tools = None
                if not isinstance(tools, list):
                    tools = None

            is_admin = bool(row["is_admin"])

            # Who previously had density (overlay ACL + admin unrestricted rule)
            had_density = False
            if isinstance(tools, list) and "density" in tools:
                had_density = True
            elif overlays is None:
                had_density = is_admin
            elif "density" in overlays:
                had_density = True

            new_overlays = overlays
            if isinstance(overlays, list) and "density" in overlays:
                new_overlays = [o for o in overlays if o != "density"]

            new_tools = tools
            if tools is None:
                # Unrestricted tools stay unrestricted, with these exceptions:
                # - admin with overlay whitelist that omitted density must not gain it
                # - non-admin who had density via overlays needs an explicit tools flag
                if is_admin and isinstance(overlays, list) and "density" not in overlays:
                    new_tools = ["hgt", "draw", "kml"]
                elif had_density and not is_admin:
                    new_tools = ["hgt", "draw", "kml", "density"]
            else:
                cleaned = [
                    t for t in tools
                    if t in valid_tools or t in drop_tools or t in always_on_tools
                ]
                cleaned = [t for t in cleaned if t not in drop_tools]
                # Preserve historically always-on tools
                for t in always_on_tools:
                    if t not in cleaned:
                        cleaned.append(t)
                if had_density and "density" not in cleaned:
                    cleaned.append("density")
                if not had_density and "density" in cleaned:
                    cleaned = [t for t in cleaned if t != "density"]
                # Keep only valid tool keys, stable order
                ordered = [t for t in valid_tools if t in cleaned]
                new_tools = ordered

            # Persist only when something changed
            over_sql = (
                "" if new_overlays is None else json.dumps(new_overlays)
            )
            tools_sql = (
                "" if new_tools is None else json.dumps(new_tools)
            )
            if over_sql != (raw_over or "") or tools_sql != (raw_tools or ""):
                cur.execute(
                    "UPDATE users SET allowed_overlays = ?, allowed_tools = ? WHERE id = ?",
                    (over_sql, tools_sql, row["id"]),
                )

        conn.commit()
    except Exception:
        pass

    # User-imported KML overlays (content stored in DB, owned by user_id)
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS user_kml_overlays (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            color TEXT NOT NULL DEFAULT '#4de2ff',
            opacity REAL NOT NULL DEFAULT 0.65,
            enabled INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_user_kml_overlays_user_id ON user_kml_overlays(user_id)"
    )
    for ddl in (
        "ALTER TABLE user_kml_overlays ADD COLUMN color TEXT NOT NULL DEFAULT '#4de2ff'",
        "ALTER TABLE user_kml_overlays ADD COLUMN opacity REAL NOT NULL DEFAULT 0.65",
        "ALTER TABLE user_kml_overlays ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0",
    ):
        try:
            cur.execute(ddl)
            conn.commit()
        except Exception:
            pass

    # Access requests from the public request-access form
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS access_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            name TEXT NOT NULL,
            company TEXT NOT NULL,
            email TEXT NOT NULL,
            features TEXT NOT NULL DEFAULT '[]',
            other_features TEXT,
            message TEXT,
            ip TEXT,
            draft_name TEXT,
            draft_email TEXT,
            draft_is_admin INTEGER NOT NULL DEFAULT 0,
            draft_fun INTEGER NOT NULL DEFAULT 0,
            draft_allowed_bases TEXT,
            draft_allowed_overlays TEXT,
            draft_allowed_tools TEXT,
            draft_limit_day INTEGER NOT NULL DEFAULT -1,
            draft_limit_week INTEGER NOT NULL DEFAULT -1,
            draft_limit_month INTEGER NOT NULL DEFAULT -1,
            reviewed_at INTEGER,
            reviewed_by INTEGER,
            created_user_id INTEGER,
            FOREIGN KEY(reviewed_by) REFERENCES users(id),
            FOREIGN KEY(created_user_id) REFERENCES users(id)
        )
        """
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_access_requests_status ON access_requests(status)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_access_requests_email ON access_requests(email)"
    )

    # Migration: pending access-request drafts — density moved overlays → tools
    try:
        valid_tools = ("hgt", "draw", "kml", "density")
        drop_tools = {"ruler", "box"}
        cur.execute(
            """
            SELECT id, draft_allowed_overlays, draft_allowed_tools
            FROM access_requests
            WHERE status = 'pending'
            """
        )
        for row in cur.fetchall():
            raw_over = row["draft_allowed_overlays"] or "[]"
            raw_tools = row["draft_allowed_tools"] or "[]"
            try:
                overlays = json.loads(raw_over) if raw_over else []
            except (json.JSONDecodeError, TypeError):
                overlays = []
            try:
                tools = json.loads(raw_tools) if raw_tools else []
            except (json.JSONDecodeError, TypeError):
                tools = []
            if not isinstance(overlays, list):
                overlays = []
            if not isinstance(tools, list):
                tools = []

            had_density = "density" in tools or "density" in overlays
            new_overlays = [o for o in overlays if o != "density"]
            cleaned = [t for t in tools if t not in drop_tools]
            if had_density and "density" not in cleaned:
                cleaned.append("density")
            new_tools = [t for t in valid_tools if t in cleaned]

            over_sql = json.dumps(new_overlays)
            tools_sql = json.dumps(new_tools)
            if over_sql != raw_over or tools_sql != raw_tools:
                cur.execute(
                    """
                    UPDATE access_requests
                    SET draft_allowed_overlays = ?, draft_allowed_tools = ?
                    WHERE id = ?
                    """,
                    (over_sql, tools_sql, row["id"]),
                )
        conn.commit()
    except Exception:
        pass

    conn.commit()
    conn.close()


def _json(value, default):
    # Store None (unrestricted) as empty string to distinguish from [] (explicitly no access)
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value)


def ensure_default_admin(email: str, password_hash: str):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) AS c FROM users")
    row = cur.fetchone()
    if row[0] == 0:
        cur.execute(
            """
            INSERT INTO users (
                email, name, password_hash, is_admin,
                allowed_bases, allowed_overlays, allowed_tools,
                limit_day, limit_week, limit_month
            )
            VALUES (?, ?, ?, 1, ?, ?, ?, -1, -1, -1)
            """,
            (
                email,
                "Administrator",
                password_hash,
                json.dumps(["osm", "dark", "esri", "shom", "ukho", "gbsouth"]),
                json.dumps(["seamarks", "openaip", "density"]),
                json.dumps(["hgt"]),
            ),
        )
        conn.commit()
    conn.close()


def user_from_row(row):
    if not row:
        return None
    # Handle both None and empty string cases properly
    try:
        allowed_bases = json.loads(row["allowed_bases"]) if row["allowed_bases"] else None
    except (json.JSONDecodeError, TypeError):
        allowed_bases = None

    try:
        allowed_overlays = json.loads(row["allowed_overlays"]) if row["allowed_overlays"] else None
    except (json.JSONDecodeError, TypeError):
        allowed_overlays = None

    try:
        allowed_tools = json.loads(row["allowed_tools"]) if row["allowed_tools"] else None
    except (json.JSONDecodeError, TypeError):
        allowed_tools = None

    # Safely get optional fields with try/except for backwards compatibility
    try:
        default_lat = row["default_lat"]
    except (KeyError, IndexError):
        default_lat = None

    try:
        default_lon = row["default_lon"]
    except (KeyError, IndexError):
        default_lon = None

    try:
        default_zoom = row["default_zoom"]
    except (KeyError, IndexError):
        default_zoom = None

    try:
        default_base = row["default_base"]
    except (KeyError, IndexError):
        default_base = None

    try:
        default_overlays_raw = row["default_overlays"]
        default_overlays = json.loads(default_overlays_raw) if default_overlays_raw else None
    except (KeyError, IndexError, json.JSONDecodeError, TypeError):
        default_overlays = None

    try:
        default_system = row["default_system"]
    except (KeyError, IndexError):
        default_system = None

    try:
        default_quality = row["default_quality"]
    except (KeyError, IndexError):
        default_quality = None

    try:
        fun = bool(row["fun"])
    except (KeyError, IndexError):
        fun = False

    try:
        default_units = row["default_units"]
    except (KeyError, IndexError):
        default_units = None

    try:
        density_opacity = row["density_opacity"]
        if density_opacity is None:
            density_opacity = 0.65  # Default opacity
    except (KeyError, IndexError):
        density_opacity = 0.65

    try:
        density_border_color = row["density_border_color"]
        if density_border_color is None:
            density_border_color = "rgba(255,255,255,0.2)"
    except (KeyError, IndexError):
        density_border_color = "rgba(255,255,255,0.2)"

    try:
        density_border_hover_color = row["density_border_hover_color"]
        if density_border_hover_color is None:
            density_border_hover_color = "rgba(0,0,0,0.9)"
    except (KeyError, IndexError):
        density_border_hover_color = "rgba(0,0,0,0.9)"

    try:
        favorite_maps_raw = row["favorite_maps"]
        favorite_maps = json.loads(favorite_maps_raw) if favorite_maps_raw else None
    except (KeyError, IndexError, json.JSONDecodeError, TypeError):
        favorite_maps = None

    try:
        favorite_overlays_raw = row["favorite_overlays"]
        favorite_overlays = json.loads(favorite_overlays_raw) if favorite_overlays_raw else None
    except (KeyError, IndexError, json.JSONDecodeError, TypeError):
        favorite_overlays = None

    try:
        onboarding_reset_version = int(row["onboarding_reset_version"] or 0)
    except (KeyError, IndexError, TypeError, ValueError):
        onboarding_reset_version = 0

    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "is_admin": bool(row["is_admin"]),
        "allowed_bases": allowed_bases,
        "allowed_overlays": allowed_overlays,
        "allowed_tools": allowed_tools,
        "limit_day": row["limit_day"],
        "limit_week": row["limit_week"],
        "limit_month": row["limit_month"],
        "default_lat": default_lat,
        "default_lon": default_lon,
        "default_zoom": default_zoom,
        "default_base": default_base,
        "default_overlays": default_overlays,
        "default_system": default_system,
        "default_quality": default_quality,
        "default_units": default_units,
        "density_opacity": density_opacity,
        "density_border_color": density_border_color,
        "density_border_hover_color": density_border_hover_color,
        "favorite_maps": favorite_maps,
        "favorite_overlays": favorite_overlays,
        "onboarding_reset_version": onboarding_reset_version,
        "fun": fun,
    }


def get_user_by_email(email: str):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM users WHERE email = ?", (email,))
    row = cur.fetchone()
    conn.close()
    return user_from_row(row), (row["password_hash"] if row else None)


def get_user_by_id(user_id: int):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = cur.fetchone()
    conn.close()
    return user_from_row(row)


def get_password_hash_by_user_id(user_id: int) -> str | None:
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,))
    row = cur.fetchone()
    conn.close()
    return row["password_hash"] if row else None


def list_users():
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM users ORDER BY id ASC")
    rows = cur.fetchall()
    conn.close()
    return [user_from_row(r) for r in rows]


def create_user(
    email: str,
    name: str,
    password_hash: str,
    is_admin: bool,
    allowed_bases,
    allowed_overlays,
    allowed_tools,
    limit_day: int,
    limit_week: int,
    limit_month: int,
):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO users (email, name, password_hash, is_admin, allowed_bases, allowed_overlays, allowed_tools, limit_day, limit_week, limit_month)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            email,
            name,
            password_hash,
            1 if is_admin else 0,
            _json(allowed_bases, []),
            _json(allowed_overlays, []),
            _json(allowed_tools, []),
            limit_day,
            limit_week,
            limit_month,
        ),
    )
    conn.commit()
    user_id = cur.lastrowid
    conn.close()
    return user_id


def update_user(
    user_id: int,
    name: str | None = None,
    email: str | None = None,
    password_hash: str | None = None,
    is_admin: bool | None = None,
    allowed_bases=None,
    allowed_overlays=None,
    allowed_tools=None,
    limit_day: int | None = None,
    limit_week: int | None = None,
    limit_month: int | None = None,
    default_lat: float | None = None,
    default_lon: float | None = None,
    default_zoom: int | None = None,
    default_base: str | None = None,
    default_overlays=None,
    default_system: str | None = None,
    default_quality: str | None = None,
    default_units: str | None = None,
    density_opacity: float | None = None,
    density_border_color: str | None = None,
    density_border_hover_color: str | None = None,
    favorite_maps=None,
    favorite_overlays=None,
    onboarding_reset_version: int | None = None,
    fun: bool | None = None,
):
    fields = []
    params = []
    if name is not None:
        fields.append("name = ?")
        params.append(name)
    if email is not None:
        fields.append("email = ?")
        params.append(email)
    if password_hash is not None:
        fields.append("password_hash = ?")
        params.append(password_hash)
    if is_admin is not None:
        fields.append("is_admin = ?")
        params.append(1 if is_admin else 0)
    if allowed_bases is not None:
        fields.append("allowed_bases = ?")
        params.append(_json(allowed_bases, []))
    if allowed_overlays is not None:
        fields.append("allowed_overlays = ?")
        params.append(_json(allowed_overlays, []))
    if allowed_tools is not None:
        fields.append("allowed_tools = ?")
        params.append(_json(allowed_tools, []))
    if limit_day is not None:
        fields.append("limit_day = ?")
        params.append(limit_day)
    if limit_week is not None:
        fields.append("limit_week = ?")
        params.append(limit_week)
    if limit_month is not None:
        fields.append("limit_month = ?")
        params.append(limit_month)
    if default_lat is not None:
        fields.append("default_lat = ?")
        params.append(default_lat)
    if default_lon is not None:
        fields.append("default_lon = ?")
        params.append(default_lon)
    if default_zoom is not None:
        fields.append("default_zoom = ?")
        params.append(default_zoom)
    if default_base is not None:
        fields.append("default_base = ?")
        params.append(default_base)
    if default_overlays is not None:
        fields.append("default_overlays = ?")
        params.append(_json(default_overlays, []))
    if default_system is not None:
        fields.append("default_system = ?")
        params.append(default_system)
    if default_quality is not None:
        fields.append("default_quality = ?")
        params.append(default_quality)
    if default_units is not None:
        fields.append("default_units = ?")
        params.append(default_units)
    if density_opacity is not None:
        fields.append("density_opacity = ?")
        params.append(density_opacity)
    if density_border_color is not None:
        fields.append("density_border_color = ?")
        params.append(density_border_color)
    if density_border_hover_color is not None:
        fields.append("density_border_hover_color = ?")
        params.append(density_border_hover_color)
    if favorite_maps is not None:
        fields.append("favorite_maps = ?")
        params.append(json.dumps(favorite_maps) if isinstance(favorite_maps, list) else favorite_maps)
    if favorite_overlays is not None:
        fields.append("favorite_overlays = ?")
        params.append(json.dumps(favorite_overlays) if isinstance(favorite_overlays, list) else favorite_overlays)
    if onboarding_reset_version is not None:
        fields.append("onboarding_reset_version = ?")
        params.append(int(onboarding_reset_version))
    if fun is not None:
        fields.append("fun = ?")
        params.append(1 if fun else 0)
    if not fields:
        return
    params.append(user_id)
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = ?", params)
    conn.commit()
    conn.close()


def delete_user(user_id: int):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()


def log_export(user_id: int, base: str, overlays):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO export_logs (user_id, ts, base, overlays) VALUES (?, ?, ?, ?)",
        (user_id, int(time.time()), base, json.dumps(overlays or {})),
    )
    conn.commit()
    log_id = cur.lastrowid
    conn.close()
    return log_id


def reserve_export_quota(
    user_id: int,
    limit_day: int,
    limit_week: int,
    limit_month: int,
    base: str,
    overlays,
) -> int:
    """Atomically check daily/weekly/monthly quotas and insert an export_logs row.

    Uses BEGIN IMMEDIATE so concurrent gunicorn workers serialize on the same DB
    and cannot all pass a check-then-act race. Returns the new export_logs.id.
    Raises PermissionError with the same messages as the old pre-check.
    """
    now = int(time.time())
    day = now - 86400
    week = now - 7 * 86400
    month = now - 30 * 86400

    conn = _get_conn()
    try:
        conn.execute("BEGIN IMMEDIATE")
        cur = conn.cursor()

        def _count_since(since_epoch: int) -> int:
            cur.execute(
                "SELECT COUNT(*) AS c FROM export_logs WHERE user_id = ? AND ts >= ?",
                (user_id, since_epoch),
            )
            row = cur.fetchone()
            return int(row[0] if row else 0)

        if limit_day >= 0 and _count_since(day) >= limit_day:
            conn.rollback()
            raise PermissionError("Daily export limit reached")
        if limit_week >= 0 and _count_since(week) >= limit_week:
            conn.rollback()
            raise PermissionError("Weekly export limit reached")
        if limit_month >= 0 and _count_since(month) >= limit_month:
            conn.rollback()
            raise PermissionError("Monthly export limit reached")

        cur.execute(
            "INSERT INTO export_logs (user_id, ts, base, overlays) VALUES (?, ?, ?, ?)",
            (user_id, now, base, json.dumps(overlays or {})),
        )
        log_id = cur.lastrowid
        conn.commit()
        return int(log_id)
    except PermissionError:
        raise
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise
    finally:
        conn.close()


def release_export_quota(log_id: int | None) -> None:
    """Remove a reserved export_logs row after a failed export (restore quota)."""
    if not log_id:
        return
    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM export_logs WHERE id = ?", (int(log_id),))
        conn.commit()
    finally:
        conn.close()


def count_exports_since(user_id: int, since_epoch: int) -> int:
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) AS c FROM export_logs WHERE user_id = ? AND ts >= ?", (user_id, since_epoch))
    row = cur.fetchone()
    conn.close()
    return row[0] if row else 0


def get_user_export_stats(user_id: int) -> dict:
    """Get detailed export statistics for a user"""
    now = int(time.time())
    day_start = now - 86400
    week_start = now - 7 * 86400
    month_start = now - 30 * 86400

    conn = _get_conn()
    cur = conn.cursor()

    # Get counts for different time periods
    stats = {
        "total": count_exports_since(user_id, 0),
        "today": count_exports_since(user_id, day_start),
        "week": count_exports_since(user_id, week_start),
        "month": count_exports_since(user_id, month_start),
    }

    # Get recent exports (last 10)
    cur.execute(
        """
        SELECT ts, base, overlays
        FROM export_logs
        WHERE user_id = ?
        ORDER BY ts DESC
        LIMIT 10
    """,
        (user_id,),
    )

    recent_exports = []
    for row in cur.fetchall():
        try:
            overlays = json.loads(row[2]) if row[2] else {}
        except json.JSONDecodeError:
            overlays = {}

        recent_exports.append(
            {
                "timestamp": row[0],
                "base": row[1],
                "overlays": overlays,
                "date": time.strftime("%Y-%m-%d %H:%M", time.localtime(row[0])),
            }
        )

    stats["recent"] = recent_exports

    # Get usage by base map type
    cur.execute(
        """
        SELECT base, COUNT(*) as count
        FROM export_logs
        WHERE user_id = ? AND ts >= ?
        GROUP BY base
        ORDER BY count DESC
    """,
        (user_id, month_start),
    )

    base_usage = dict(cur.fetchall())
    stats["base_usage"] = base_usage

    conn.close()
    return stats


def update_user_preferences(
    user_id: int,
    default_lat: float | None = None,
    default_lon: float | None = None,
    default_zoom: int | None = None,
    default_base: str | None = None,
    default_overlays=None,
    default_system: str | None = None,
    default_quality: str | None = None,
    default_units: str | None = None,
    density_opacity: float | None = None,
    density_border_color: str | None = None,
    density_border_hover_color: str | None = None,
    favorite_maps=None,
    favorite_overlays=None,
):
    """Update user's default map position, zoom, layer/export preferences, density settings, and favorites"""
    update_user(
        user_id,
        default_lat=default_lat,
        default_lon=default_lon,
        default_zoom=default_zoom,
        default_base=default_base,
        default_overlays=default_overlays,
        default_system=default_system,
        default_quality=default_quality,
        default_units=default_units,
        density_opacity=density_opacity,
        density_border_color=density_border_color,
        density_border_hover_color=density_border_hover_color,
        favorite_maps=favorite_maps,
        favorite_overlays=favorite_overlays,
    )


def get_all_export_stats() -> dict:
    """Get system-wide export statistics"""
    now = int(time.time())
    day_start = now - 86400
    week_start = now - 7 * 86400
    month_start = now - 30 * 86400

    conn = _get_conn()
    cur = conn.cursor()

    # Total exports by time period
    cur.execute("SELECT COUNT(*) FROM export_logs WHERE ts >= ?", (day_start,))
    today = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM export_logs WHERE ts >= ?", (week_start,))
    week = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM export_logs WHERE ts >= ?", (month_start,))
    month = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM export_logs")
    total = cur.fetchone()[0]

    # Most active users (this month)
    cur.execute(
        """
        SELECT u.email, u.name, COUNT(e.id) as export_count
        FROM users u
        LEFT JOIN export_logs e ON u.id = e.user_id AND e.ts >= ?
        GROUP BY u.id, u.email, u.name
        ORDER BY export_count DESC
        LIMIT 5
    """,
        (month_start,),
    )

    top_users = []
    for row in cur.fetchall():
        top_users.append({"email": row[0], "name": row[1] or "No name", "exports": row[2]})

    # Popular base maps (this month)
    cur.execute(
        """
        SELECT base, COUNT(*) as count
        FROM export_logs
        WHERE ts >= ?
        GROUP BY base
        ORDER BY count DESC
    """,
        (month_start,),
    )

    popular_bases = dict(cur.fetchall())

    conn.close()

    return {
        "today": today,
        "week": week,
        "month": month,
        "total": total,
        "top_users": top_users,
        "popular_bases": popular_bases,
    }


# ---- User KML overlays ----

MAX_KML_PER_USER = 10
MAX_KML_STORAGE_BYTES = 50 * 1024 * 1024 * 1024  # 50 GB total per user
MAX_KML_BYTES = MAX_KML_STORAGE_BYTES  # single file may fill remaining quota


def count_user_kml(user_id: int) -> int:
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM user_kml_overlays WHERE user_id = ?", (user_id,))
    n = int(cur.fetchone()[0])
    conn.close()
    return n


def sum_user_kml_bytes(user_id: int) -> int:
    """Total stored KML size for a user (UTF-8 / blob byte length)."""
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        "SELECT COALESCE(SUM(LENGTH(CAST(content AS BLOB))), 0) FROM user_kml_overlays WHERE user_id = ?",
        (user_id,),
    )
    total = int(cur.fetchone()[0] or 0)
    conn.close()
    return total


def _kml_meta_from_row(r, include_content=False):
    try:
        color = r["color"] or "#4de2ff"
    except (KeyError, IndexError):
        color = "#4de2ff"
    try:
        opacity = float(r["opacity"] if r["opacity"] is not None else 0.65)
    except (KeyError, IndexError, TypeError, ValueError):
        opacity = 0.65
    try:
        enabled = bool(int(r["enabled"] or 0))
    except (KeyError, IndexError, TypeError, ValueError):
        enabled = False
    opacity = max(0.0, min(1.0, opacity))
    out = {
        "id": int(r["id"]),
        "name": r["name"],
        "created_at": int(r["created_at"]),
        "color": color if isinstance(color, str) and color.startswith("#") else "#4de2ff",
        "opacity": opacity,
        "enabled": enabled,
    }
    try:
        out["size_bytes"] = int(r["size_bytes"] or 0)
    except (KeyError, IndexError, TypeError):
        pass
    if include_content:
        out["content"] = r["content"]
        out["user_id"] = int(r["user_id"])
    return out


def list_user_kml(user_id: int):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, name, created_at, LENGTH(CAST(content AS BLOB)) AS size_bytes,
               color, opacity, enabled
        FROM user_kml_overlays
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        """,
        (user_id,),
    )
    rows = [_kml_meta_from_row(r) for r in cur.fetchall()]
    conn.close()
    return rows


def get_user_kml(user_id: int, kml_id: int):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, user_id, name, content, created_at, color, opacity, enabled,
               LENGTH(CAST(content AS BLOB)) AS size_bytes
        FROM user_kml_overlays
        WHERE id = ? AND user_id = ?
        """,
        (kml_id, user_id),
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        return None
    return _kml_meta_from_row(row, include_content=True)


def create_user_kml(user_id: int, name: str, content: str, color="#4de2ff", opacity=0.65, enabled=0):
    conn = _get_conn()
    cur = conn.cursor()
    now = int(time.time())
    opacity = max(0.0, min(1.0, float(opacity)))
    cur.execute(
        """
        INSERT INTO user_kml_overlays (user_id, name, content, created_at, color, opacity, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (user_id, name, content, now, color or "#4de2ff", opacity, 1 if enabled else 0),
    )
    kml_id = int(cur.lastrowid)
    conn.commit()
    conn.close()
    return {
        "id": kml_id,
        "name": name,
        "created_at": now,
        "size_bytes": len(content.encode("utf-8")),
        "color": color or "#4de2ff",
        "opacity": opacity,
        "enabled": bool(enabled),
    }


def update_user_kml(user_id: int, kml_id: int, **fields):
    allowed = {}
    if "name" in fields and fields["name"] is not None:
        name = str(fields["name"]).strip()[:120]
        if name:
            allowed["name"] = name
    if "color" in fields and fields["color"] is not None:
        color = str(fields["color"]).strip()
        if color.startswith("#") and len(color) in (4, 7):
            allowed["color"] = color
    if "opacity" in fields and fields["opacity"] is not None:
        try:
            allowed["opacity"] = max(0.0, min(1.0, float(fields["opacity"])))
        except (TypeError, ValueError):
            pass
    if "enabled" in fields and fields["enabled"] is not None:
        allowed["enabled"] = 1 if fields["enabled"] else 0

    if not allowed:
        return get_user_kml(user_id, kml_id)

    sets = ", ".join(f"{k} = ?" for k in allowed.keys())
    values = list(allowed.values()) + [kml_id, user_id]
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        f"UPDATE user_kml_overlays SET {sets} WHERE id = ? AND user_id = ?",
        values,
    )
    updated = cur.rowcount > 0
    conn.commit()
    conn.close()
    if not updated:
        return None
    return get_user_kml(user_id, kml_id)


def delete_user_kml(user_id: int, kml_id: int) -> bool:
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        "DELETE FROM user_kml_overlays WHERE id = ? AND user_id = ?",
        (kml_id, user_id),
    )
    deleted = cur.rowcount > 0
    conn.commit()
    conn.close()
    return deleted


def _parse_json_list(raw):
    if raw is None or raw == "":
        return None
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return None
    return value if isinstance(value, list) else None


def access_request_from_row(row) -> dict:
    if not row:
        return None
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "status": row["status"],
        "name": row["name"] or "",
        "company": row["company"] or "",
        "email": row["email"] or "",
        "features": _parse_json_list(row["features"]) or [],
        "other_features": row["other_features"] or "",
        "message": row["message"] or "",
        "ip": row["ip"] or "",
        "draft_name": row["draft_name"] if row["draft_name"] is not None else (row["name"] or ""),
        "draft_email": row["draft_email"] if row["draft_email"] is not None else (row["email"] or ""),
        "draft_is_admin": bool(row["draft_is_admin"]),
        "draft_fun": bool(row["draft_fun"]),
        "draft_allowed_bases": _parse_json_list(row["draft_allowed_bases"]),
        "draft_allowed_overlays": _parse_json_list(row["draft_allowed_overlays"]) or [],
        "draft_allowed_tools": _parse_json_list(row["draft_allowed_tools"]) or [],
        "draft_limit_day": int(row["draft_limit_day"] if row["draft_limit_day"] is not None else -1),
        "draft_limit_week": int(row["draft_limit_week"] if row["draft_limit_week"] is not None else -1),
        "draft_limit_month": int(row["draft_limit_month"] if row["draft_limit_month"] is not None else -1),
        "reviewed_at": row["reviewed_at"],
        "reviewed_by": row["reviewed_by"],
        "created_user_id": row["created_user_id"],
    }


def create_access_request(
    *,
    name: str,
    company: str,
    email: str,
    features: list,
    other_features: str = "",
    message: str = "",
    ip: str = "",
    draft_name: str | None = None,
    draft_email: str | None = None,
    draft_is_admin: bool = False,
    draft_fun: bool = False,
    draft_allowed_bases=None,
    draft_allowed_overlays=None,
    draft_allowed_tools=None,
    draft_limit_day: int = -1,
    draft_limit_week: int = -1,
    draft_limit_month: int = -1,
) -> int:
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO access_requests (
            created_at, status, name, company, email, features, other_features, message, ip,
            draft_name, draft_email, draft_is_admin, draft_fun,
            draft_allowed_bases, draft_allowed_overlays, draft_allowed_tools,
            draft_limit_day, draft_limit_week, draft_limit_month
        ) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            int(time.time()),
            name,
            company,
            email,
            json.dumps(features or []),
            other_features or "",
            message or "",
            ip or "",
            draft_name if draft_name is not None else name,
            draft_email if draft_email is not None else email,
            1 if draft_is_admin else 0,
            1 if draft_fun else 0,
            _json(draft_allowed_bases, []),
            _json(draft_allowed_overlays if draft_allowed_overlays is not None else [], []),
            _json(draft_allowed_tools if draft_allowed_tools is not None else [], []),
            draft_limit_day,
            draft_limit_week,
            draft_limit_month,
        ),
    )
    conn.commit()
    request_id = cur.lastrowid
    conn.close()
    return request_id


def list_access_requests(status: str | None = "pending"):
    conn = _get_conn()
    cur = conn.cursor()
    if status:
        cur.execute(
            "SELECT * FROM access_requests WHERE status = ? ORDER BY created_at DESC",
            (status,),
        )
    else:
        cur.execute("SELECT * FROM access_requests ORDER BY created_at DESC")
    rows = cur.fetchall()
    conn.close()
    return [access_request_from_row(r) for r in rows]


def get_access_request(request_id: int):
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM access_requests WHERE id = ?", (request_id,))
    row = cur.fetchone()
    conn.close()
    return access_request_from_row(row)


def update_access_request_draft(request_id: int, **fields) -> dict | None:
    allowed = {
        "draft_name",
        "draft_email",
        "draft_is_admin",
        "draft_fun",
        "draft_allowed_bases",
        "draft_allowed_overlays",
        "draft_allowed_tools",
        "draft_limit_day",
        "draft_limit_week",
        "draft_limit_month",
    }
    sets = []
    params = []
    for key, value in fields.items():
        if key not in allowed:
            continue
        if key in {"draft_is_admin", "draft_fun"}:
            sets.append(f"{key} = ?")
            params.append(1 if value else 0)
        elif key in {"draft_allowed_bases", "draft_allowed_overlays", "draft_allowed_tools"}:
            sets.append(f"{key} = ?")
            params.append(_json(value, []))
        else:
            sets.append(f"{key} = ?")
            params.append(value)
    if not sets:
        return get_access_request(request_id)
    params.append(request_id)
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        f"UPDATE access_requests SET {', '.join(sets)} WHERE id = ? AND status = 'pending'",
        params,
    )
    updated = cur.rowcount > 0
    conn.commit()
    conn.close()
    if not updated:
        return None
    return get_access_request(request_id)


def mark_access_request_approved(request_id: int, *, admin_id: int, created_user_id: int) -> bool:
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE access_requests
        SET status = 'approved', reviewed_at = ?, reviewed_by = ?, created_user_id = ?
        WHERE id = ? AND status = 'pending'
        """,
        (int(time.time()), admin_id, created_user_id, request_id),
    )
    ok = cur.rowcount > 0
    conn.commit()
    conn.close()
    return ok


def mark_access_request_dismissed(request_id: int, *, admin_id: int) -> bool:
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE access_requests
        SET status = 'dismissed', reviewed_at = ?, reviewed_by = ?
        WHERE id = ? AND status = 'pending'
        """,
        (int(time.time()), admin_id, request_id),
    )
    ok = cur.rowcount > 0
    conn.commit()
    conn.close()
    return ok


def count_pending_access_requests() -> int:
    conn = _get_conn()
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM access_requests WHERE status = 'pending'")
    n = int(cur.fetchone()[0] or 0)
    conn.close()
    return n
