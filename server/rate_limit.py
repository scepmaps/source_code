"""Simple in-process sliding-window rate limiter (per-worker)."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


class SlidingWindowLimiter:
    def __init__(self):
        self._lock = threading.Lock()
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str, *, limit: int, window_seconds: float) -> bool:
        """Return True if the event is allowed; False if over limit."""
        if limit <= 0:
            return False
        now = time.monotonic()
        cutoff = now - window_seconds
        with self._lock:
            bucket = self._hits[key]
            while bucket and bucket[0] < cutoff:
                bucket.popleft()
            if len(bucket) >= limit:
                return False
            bucket.append(now)
            # Opportunistic cleanup of idle keys
            if len(self._hits) > 5000:
                stale = [k for k, v in self._hits.items() if not v or v[-1] < cutoff]
                for k in stale[:500]:
                    self._hits.pop(k, None)
            return True


# Shared limiter for public access-request endpoint
access_request_limiter = SlidingWindowLimiter()
