import os
import time
import hashlib
import hmac
import base64
import json
from typing import Optional, Tuple

SECRET = os.getenv("AUTH_SECRET", "dev-secret-change-me")


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100_000)
    return base64.b64encode(salt + dk).decode('ascii')


def verify_password(password: str, password_hash: str) -> bool:
    raw = base64.b64decode(password_hash.encode('ascii'))
    salt, stored = raw[:16], raw[16:]
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100_000)
    return hmac.compare_digest(stored, dk)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode('ascii')


def _b64url_decode(data: str) -> bytes:
    pad = '=' * (-len(data) % 4)
    return base64.urlsafe_b64decode((data + pad).encode('ascii'))


def mint_token(payload: dict, ttl_seconds: int = 86400) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    body = dict(payload)
    body['iat'] = now
    body['exp'] = now + ttl_seconds
    h = _b64url(json.dumps(header, separators=(',', ':')).encode('utf-8'))
    p = _b64url(json.dumps(body, separators=(',', ':')).encode('utf-8'))
    msg = f"{h}.{p}".encode('ascii')
    sig = hmac.new(SECRET.encode('utf-8'), msg, hashlib.sha256).digest()
    s = _b64url(sig)
    return f"{h}.{p}.{s}"


def verify_token(token: str) -> Optional[dict]:
    try:
        h, p, s = token.split('.')
        msg = f"{h}.{p}".encode('ascii')
        expected = hmac.new(SECRET.encode('utf-8'), msg, hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64url_decode(s)):
            return None
        payload = json.loads(_b64url_decode(p).decode('utf-8'))
        if payload.get('exp', 0) < int(time.time()):
            return None
        return payload
    except Exception:
        return None



