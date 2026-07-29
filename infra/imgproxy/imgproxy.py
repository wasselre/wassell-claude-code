#!/usr/bin/env python3
"""
imgproxy — minimal, allowlisted, token-gated image fetcher for the Wassel CRM.

Why this exists: Aqar's CDN (Cloudflare) returns 403 to Fly.io's datacenter
egress IPs, so worker/src/runCleanTextJob.ts cannot download a listing photo
before handing it to fal. This VM's me-central1 address is not blocked, so the
worker falls back to GET /fetch?url=... here and gets the bytes.

Deliberately NOT a general-purpose proxy:
  - requires Authorization: Bearer <IMGPROXY_TOKEN>
  - only fetches hosts in ALLOWED_HOSTS (exact match)
  - only https, only image/* responses, hard size + time caps
Those four together mean a leaked token still cannot be used to reach anything
but public Aqar listing photos (no SSRF into GCP metadata or the WAHA container).

Listens on 127.0.0.1 only; Caddy terminates TLS and routes /imgproxy/* here.
"""

import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("IMGPROXY_TOKEN", "")
PORT = int(os.environ.get("IMGPROXY_PORT", "8090"))
ALLOWED_HOSTS = {"images.aqar.fm", "sa.aqar.fm"}
MAX_BYTES = 25 * 1024 * 1024
TIMEOUT_S = 30

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Referer": "https://sa.aqar.fm/",
    "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    "Accept-Language": "ar,en;q=0.9",
}

if not TOKEN:
    sys.stderr.write("imgproxy: IMGPROXY_TOKEN is not set — refusing to start\n")
    sys.exit(1)


class Handler(BaseHTTPRequestHandler):
    server_version = "wassel-imgproxy/1.0"

    def _fail(self, code: int, msg: str) -> None:
        body = msg.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/healthz":
            self._fail(200, "ok")
            return

        if parsed.path != "/fetch":
            self._fail(404, "not found")
            return

        if self.headers.get("Authorization", "") != f"Bearer {TOKEN}":
            self._fail(401, "unauthorized")
            return

        target = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
        if not target:
            self._fail(400, "missing url")
            return

        t = urllib.parse.urlparse(target)
        if t.scheme != "https" or t.hostname not in ALLOWED_HOSTS:
            self._fail(403, f"host not allowed: {t.hostname}")
            return

        req = urllib.request.Request(target, headers=BROWSER_HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
                ctype = res.headers.get("Content-Type", "application/octet-stream")
                if not ctype.startswith("image/"):
                    self._fail(502, f"upstream returned non-image content-type: {ctype}")
                    return
                data = res.read(MAX_BYTES + 1)
        except urllib.error.HTTPError as e:
            self._fail(502, f"upstream {e.code}")
            return
        except Exception as e:  # network/DNS/timeout — surface it, never silently blank
            self._fail(502, f"upstream fetch failed: {type(e).__name__}: {e}")
            return

        if len(data) > MAX_BYTES:
            self._fail(413, "image too large")
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("imgproxy %s\n" % (fmt % args))


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
