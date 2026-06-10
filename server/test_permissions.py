import json
import os
import tempfile

import pytest
from app import app as flask_app
from auth import hash_password, mint_token
from db import create_user, ensure_default_admin, get_user_by_email, init_db


@pytest.fixture(autouse=True)
def isolated_db(monkeypatch):
    # Use a temp DB per test run
    fd, path = tempfile.mkstemp()
    os.close(fd)
    monkeypatch.setenv("USERS_DB_PATH", path)
    from importlib import reload

    import db as dbmod

    reload(dbmod)
    dbmod.init_db()
    yield
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def client():
    flask_app.config.update(TESTING=True)
    return flask_app.test_client()


def login_token(user_id, is_admin=False):
    return mint_token({"uid": user_id, "adm": is_admin}, ttl_seconds=3600)


def test_export_requires_authentication(monkeypatch):
    c = client()
    resp = c.post(
        "/export",
        headers={"Content-Type": "application/json"},
        data=json.dumps(
            {
                "bbox": [0, 0, 1, 1],
                "zoom": 2,
                "width": 256,
                "height": 256,
                "base": "osm",
                "overlays": {},
                "crs": "EPSG:4326",
            }
        ),
    )
    assert resp.status_code == 401


def test_export_rejects_invalid_token(monkeypatch):
    c = client()
    resp = c.post(
        "/export",
        headers={"Authorization": "Bearer not.a.valid.jwt", "Content-Type": "application/json"},
        data=json.dumps(
            {
                "bbox": [0, 0, 1, 1],
                "zoom": 2,
                "width": 256,
                "height": 256,
                "base": "osm",
                "overlays": {},
                "crs": "EPSG:4326",
            }
        ),
    )
    assert resp.status_code == 401


def test_auth_me_returns_refreshed_token(monkeypatch):
    from db import create_user

    uid = create_user("u@test", "U", hash_password("pw"), False, None, None, None, -1, -1, -1)
    c = client()
    token = login_token(uid)
    resp = c.get("/auth/me", headers={"Authorization": "Bearer " + token})
    assert resp.status_code == 200
    data = resp.get_json()
    assert data.get("token")
    assert data["token"] != token
    assert data["user"]["email"] == "u@test"


def test_permissions_empty_lists_block_all_bases_and_overlays(monkeypatch):
    # Create user with no access
    from db import create_user

    uid = create_user("u1@test", "U1", hash_password("pw"), False, [], [], [], -1, -1, -1)
    c = client()
    token = login_token(uid)
    # Attempt export with OSM and seamarks should fail
    resp = c.post(
        "/export",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=json.dumps(
            {
                "bbox": [0, 0, 1, 1],
                "zoom": 2,
                "width": 256,
                "height": 256,
                "base": "osm",
                "overlays": {"seamarks": True},
                "crs": "EPSG:4326",
            }
        ),
    )
    assert resp.status_code in (401, 403, 500)


def test_permissions_whitelist_allows_only_listed():
    # User allows only esri base and no overlays
    uid = create_user("u2@test", "U2", hash_password("pw"), False, ["esri"], [], None, -1, -1, -1)
    c = client()
    token = login_token(uid)
    # esri ok
    resp = c.post(
        "/export",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=json.dumps(
            {
                "bbox": [0, 0, 1, 1],
                "zoom": 2,
                "width": 256,
                "height": 256,
                "base": "esri",
                "overlays": {},
                "crs": "EPSG:4326",
            }
        ),
    )
    # May fail due to tile fetch; accept any 2xx or 5xx but ensure not permission denied
    assert resp.status_code != 401 and resp.status_code != 403
    # osm denied
    resp2 = c.post(
        "/export",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=json.dumps(
            {
                "bbox": [0, 0, 1, 1],
                "zoom": 2,
                "width": 256,
                "height": 256,
                "base": "osm",
                "overlays": {},
                "crs": "EPSG:4326",
            }
        ),
    )
    assert resp2.status_code in (401, 403, 500)


def test_permissions_unrestricted_defaults_allow_all():
    # When allowed_* omitted (None), defaults allow all
    uid = create_user("u3@test", "U3", hash_password("pw"), False, None, None, None, -1, -1, -1)
    c = client()
    token = login_token(uid)
    resp = c.post(
        "/export",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=json.dumps(
            {
                "bbox": [0, 0, 1, 1],
                "zoom": 2,
                "width": 256,
                "height": 256,
                "base": "osm",
                "overlays": {"seamarks": True},
                "crs": "EPSG:4326",
            }
        ),
    )
    assert resp.status_code != 401 and resp.status_code != 403


def test_permissions_empty_overlay_list_blocks_overlays():
    # User allows bases but no overlays
    uid = create_user("u4@test", "U4", hash_password("pw"), False, ["osm"], [], None, -1, -1, -1)
    c = client()
    token = login_token(uid)
    # osm without overlays should work
    resp = c.post(
        "/export",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=json.dumps(
            {
                "bbox": [0, 0, 1, 1],
                "zoom": 2,
                "width": 256,
                "height": 256,
                "base": "osm",
                "overlays": {},
                "crs": "EPSG:4326",
            }
        ),
    )
    assert resp.status_code != 401 and resp.status_code != 403
    # osm with seamarks should fail
    resp2 = c.post(
        "/export",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=json.dumps(
            {
                "bbox": [0, 0, 1, 1],
                "zoom": 2,
                "width": 256,
                "height": 256,
                "base": "osm",
                "overlays": {"seamarks": True},
                "crs": "EPSG:4326",
            }
        ),
    )
    assert resp2.status_code in (401, 403, 500)


def test_permissions_partial_whitelist():
    # User allows only specific items
    uid = create_user("u5@test", "U5", hash_password("pw"), False, ["osm", "esri"], ["seamarks"], None, -1, -1, -1)
    c = client()
    token = login_token(uid)
    # Allowed combination
    resp = c.post(
        "/export",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=json.dumps(
            {
                "bbox": [0, 0, 1, 1],
                "zoom": 2,
                "width": 256,
                "height": 256,
                "base": "osm",
                "overlays": {"seamarks": True},
                "crs": "EPSG:4326",
            }
        ),
    )
    assert resp.status_code != 401 and resp.status_code != 403
    # Disallowed base
    resp2 = c.post(
        "/export",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=json.dumps(
            {
                "bbox": [0, 0, 1, 1],
                "zoom": 2,
                "width": 256,
                "height": 256,
                "base": "shom",
                "overlays": {},
                "crs": "EPSG:4326",
            }
        ),
    )
    assert resp2.status_code in (401, 403, 500)
    # Disallowed overlay
    resp3 = c.post(
        "/export",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        data=json.dumps(
            {
                "bbox": [0, 0, 1, 1],
                "zoom": 2,
                "width": 256,
                "height": 256,
                "base": "osm",
                "overlays": {"openaip": True},
                "crs": "EPSG:4326",
            }
        ),
    )
    assert resp3.status_code in (401, 403, 500)
