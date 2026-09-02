"""Supabase Storage REST helpers (service-role, PUBLIC bucket `marketing-assets`).

Upload uses `POST /storage/v1/object/<bucket>/<path>` with `x-upsert: true`, so
re-processing the same video overwrites the same deterministic paths instead
of creating orphans. Every failure raises after 3 attempts — an upload that
silently fails would leave a frame row pointing at a 404.
"""

from __future__ import annotations

import os
import time
from concurrent.futures import ThreadPoolExecutor

import httpx

BUCKET = "marketing-assets"
FRAME_PREFIX = "content/frame"
UPLOAD_WORKERS = 12
ATTEMPTS = 3


def frame_path(video_id: str, ts_ms: int) -> str:
    return f"{FRAME_PREFIX}/{video_id}/{int(ts_ms):07d}.webp"


def public_url(base_url: str, path: str) -> str:
    return f"{base_url.rstrip('/')}/storage/v1/object/public/{BUCKET}/{path}"


class Storage:
    def __init__(self, base_url: str | None = None, service_key: str | None = None):
        self.base_url = (base_url or os.environ["SUPABASE_URL"]).rstrip("/")
        self.key = service_key or os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.client = httpx.Client(timeout=httpx.Timeout(60.0, connect=15.0))

    def _headers(self, extra: dict | None = None) -> dict:
        h = {"Authorization": f"Bearer {self.key}", "apikey": self.key}
        if extra:
            h.update(extra)
        return h

    def upload(self, path: str, data: bytes, content_type: str = "image/webp") -> None:
        url = f"{self.base_url}/storage/v1/object/{BUCKET}/{path}"
        last: Exception | None = None
        for attempt in range(1, ATTEMPTS + 1):
            try:
                r = self.client.post(
                    url, content=data,
                    headers=self._headers({"Content-Type": content_type, "x-upsert": "true", "cache-control": "31536000"}),
                )
                if r.status_code in (200, 201):
                    return
                last = RuntimeError(f"storage upload {path}: HTTP {r.status_code} {r.text[:200]}")
                if 400 <= r.status_code < 500 and r.status_code not in (408, 429):
                    raise last
            except httpx.HTTPError as e:
                last = e
            time.sleep(0.5 * attempt)
        raise RuntimeError(f"storage upload failed after {ATTEMPTS} attempts: {last!r}")

    def upload_many(self, items: list[tuple[str, bytes]]) -> None:
        with ThreadPoolExecutor(max_workers=UPLOAD_WORKERS) as ex:
            list(ex.map(lambda it: self.upload(it[0], it[1]), items))

    def list_prefix(self, prefix: str, limit: int = 1000) -> list[dict]:
        url = f"{self.base_url}/storage/v1/object/list/{BUCKET}"
        r = self.client.post(url, json={"prefix": prefix, "limit": limit, "offset": 0, "sortBy": {"column": "name", "order": "asc"}}, headers=self._headers())
        r.raise_for_status()
        return r.json()

    def delete(self, paths: list[str]) -> dict:
        url = f"{self.base_url}/storage/v1/object/{BUCKET}"
        r = self.client.request("DELETE", url, json={"prefixes": paths}, headers=self._headers())
        r.raise_for_status()
        return {"deleted": len(r.json()) if isinstance(r.json(), list) else r.json()}

    def download(self, url: str, dest: str) -> tuple[int, str]:
        """Stream a (public) URL to disk; returns (bytes, sha256)."""
        import hashlib

        h = hashlib.sha256()
        n = 0
        with self.client.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(300.0, connect=15.0)) as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
                    h.update(chunk)
                    n += len(chunk)
        if n == 0:
            raise RuntimeError(f"download: empty body from {url}")
        return n, h.hexdigest()
