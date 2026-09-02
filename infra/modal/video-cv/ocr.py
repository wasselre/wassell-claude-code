"""OCR on dup-group REPRESENTATIVE frames only.

Engine order:
  1. the deployed Modal app `wassel-ocr` (class `OCR`, method `parse`, takes PNG
     bytes) — `ocr_engine = 'wassel-ocr'`;
  2. PaddleOCR (lang='ar', which also reads Latin letters + digits) inside this
     image — `ocr_engine = 'paddleocr'` — used for any item the remote call
     could not produce (per-item exception or a whole-call failure).
If BOTH fail for a frame the frame gets `{text:'', lang:'none', boxes:[],
engine:'failed', error:'…'}` and the failure is appended to the manifest's
`warnings` — nothing is swallowed.

Members of a dup group are left with `ocr = null`; `mkt_cv_finalize_video`
copies the representative's OCR into them and stamps `inherited_from` with the
representative's frame id. The manifest therefore only ever carries
`inherited_from_ts_ms: null` on representatives (the key is present so the
shape is stable — the DB step owns inheritance).
"""

from __future__ import annotations

import io
import re
import traceback
from typing import Any

import numpy as np
from PIL import Image

AR_RE = re.compile(r"[؀-ۿ]")
LAT_RE = re.compile(r"[A-Za-z]")


def detect_lang(text: str) -> str:
    ar = len(AR_RE.findall(text))
    la = len(LAT_RE.findall(text))
    if ar == 0 and la == 0:
        return "none"
    if ar and la:
        minor = min(ar, la) / float(ar + la)
        return "mixed" if minor >= 0.15 else ("ar" if ar > la else "en")
    return "ar" if ar else "en"


def _coerce_text(res: Any) -> str:
    """The wassel-ocr `parse` result shape is not pinned; accept str / dict / list."""
    if res is None:
        return ""
    if isinstance(res, str):
        return res.strip()
    if isinstance(res, dict):
        for k in ("text", "markdown", "result", "content"):
            v = res.get(k)
            if isinstance(v, str):
                return v.strip()
        return ""
    if isinstance(res, (list, tuple)):
        return "\n".join(t for t in (_coerce_text(x) for x in res) if t)
    return str(res).strip()


def _webp_to_png(webp: bytes) -> bytes:
    im = Image.open(io.BytesIO(webp)).convert("RGB")
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def _clean(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text)          # strip any html-ish tags from VLM output
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


class OCREngine:
    def __init__(self, log):
        self.log = log
        self._paddle = None

    # ── remote wassel-ocr ───────────────────────────────────────────────────
    def _remote(self, pngs: list[bytes]) -> list[Any]:
        import modal

        OCR = modal.Cls.from_name("wassel-ocr", "OCR")
        return list(OCR().parse.map(pngs, return_exceptions=True))

    # ── local PaddleOCR fallback ────────────────────────────────────────────
    def _paddle_engine(self):
        if self._paddle is None:
            from paddleocr import PaddleOCR

            self._paddle = PaddleOCR(lang="ar", use_angle_cls=False, show_log=False, use_gpu=False)
        return self._paddle

    def _paddle_one(self, webp: bytes) -> dict:
        import cv2

        im = np.asarray(Image.open(io.BytesIO(webp)).convert("RGB"))
        bgr = cv2.cvtColor(im, cv2.COLOR_RGB2BGR)
        res = self._paddle_engine().ocr(bgr, cls=False)
        lines: list[str] = []
        boxes: list[dict] = []
        for page in res or []:
            for item in page or []:
                box, (text, conf) = item[0], item[1]
                if not text:
                    continue
                lines.append(text)
                boxes.append({"box": [[int(round(x)), int(round(y))] for x, y in box], "text": text, "conf": round(float(conf), 4)})
        text = _clean("\n".join(lines))
        return {"text": text, "lang": detect_lang(text), "boxes": boxes, "engine": "paddleocr", "inherited_from_ts_ms": None}

    # ── public ──────────────────────────────────────────────────────────────
    def run(self, webps: list[bytes], warnings: list[str]) -> tuple[list[dict], str]:
        """OCR every blob. Returns (per-frame ocr dicts, primary engine name)."""
        if not webps:
            return [], "none"
        pngs = [_webp_to_png(b) for b in webps]
        results: list[dict | None] = [None] * len(pngs)
        remote_ok = 0
        try:
            raw = self._remote(pngs)
            if len(raw) != len(pngs):
                raise RuntimeError(f"wassel-ocr returned {len(raw)} results for {len(pngs)} inputs")
            for i, r in enumerate(raw):
                if isinstance(r, BaseException):
                    self.log(f"[ocr] wassel-ocr item {i} failed: {r!r}")
                    continue
                text = _clean(_coerce_text(r))
                results[i] = {"text": text, "lang": detect_lang(text), "boxes": [], "engine": "wassel-ocr", "inherited_from_ts_ms": None}
                remote_ok += 1
        except Exception as e:  # any transport / lookup / app failure → fall back for the whole batch
            msg = f"wassel-ocr unavailable, falling back to paddleocr: {e!r}"
            self.log("[ocr] " + msg)
            warnings.append(msg)

        fallback = [i for i, r in enumerate(results) if r is None]
        if fallback:
            self.log(f"[ocr] paddleocr fallback for {len(fallback)}/{len(pngs)} frames")
            for i in fallback:
                try:
                    results[i] = self._paddle_one(webps[i])
                except Exception as e:
                    err = f"paddleocr failed on frame {i}: {e!r}"
                    self.log("[ocr] " + err + "\n" + traceback.format_exc())
                    warnings.append(err)
                    results[i] = {"text": "", "lang": "none", "boxes": [], "engine": "failed", "error": repr(e), "inherited_from_ts_ms": None}

        engines = [r["engine"] for r in results if r]
        if remote_ok == len(pngs):
            primary = "wassel-ocr"
        elif engines and all(e == "failed" for e in engines):
            primary = "failed"
        elif remote_ok == 0:
            primary = "paddleocr"
        else:
            primary = "wassel-ocr+paddleocr"
        return [r for r in results if r is not None], primary
