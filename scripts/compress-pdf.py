#!/usr/bin/env python3
"""Compress an image-heavy PDF by re-rendering each page to a JPEG at a target
DPI and rebuilding the document. Used by backfill-brochure-urls.mjs for the
oversized developer brochures (77-126 MB) that exceed Supabase Storage's
single-request upload ceiling and WhatsApp's 100 MB document limit.

These brochures are almost entirely full-bleed imagery, so flattening to JPEG
pages is a faithful, predictable way to hit a size ceiling. We start at a high
DPI and step down only if the result is still over target, so quality stays as
high as the ceiling allows.

Usage: python compress-pdf.py <in.pdf> <out.pdf> [target_mb=45]
Prints the chosen dpi/quality + final size to stderr. Exit 0 always (writes the
smallest it produced even if it can't get under target); exit 2 on a real error.
"""
import sys
import fitz  # PyMuPDF


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: compress-pdf.py <in.pdf> <out.pdf> [target_mb]", file=sys.stderr)
        return 2
    src, out = sys.argv[1], sys.argv[2]
    target = (float(sys.argv[3]) if len(sys.argv) > 3 else 45.0) * 1024 * 1024

    try:
        doc = fitz.open(src)
    except Exception as e:  # noqa: BLE001 — surface the real parse error
        print(f"open failed: {e}", file=sys.stderr)
        return 2

    def build(dpi: int, q: int) -> bytes:
        new = fitz.open()
        try:
            for page in doc:
                rect = page.rect
                pix = page.get_pixmap(dpi=dpi)  # RGB, white background, flattened
                jpg = pix.tobytes("jpeg", jpg_quality=q)
                npage = new.new_page(width=rect.width, height=rect.height)
                npage.insert_image(npage.rect, stream=jpg)
            return new.tobytes(garbage=4, deflate=True)
        finally:
            new.close()

    last = b""
    for dpi, q in [(200, 82), (160, 80), (130, 75), (110, 70), (90, 65)]:
        try:
            buf = build(dpi, q)
        except Exception as e:  # noqa: BLE001
            print(f"render failed at dpi={dpi}: {e}", file=sys.stderr)
            return 2
        last = buf
        if len(buf) <= target:
            with open(out, "wb") as fh:
                fh.write(buf)
            print(f"dpi={dpi} q={q} -> {len(buf) / 1024 / 1024:.1f} MB", file=sys.stderr)
            return 0

    with open(out, "wb") as fh:
        fh.write(last)
    print(f"MIN dpi=90 -> {len(last) / 1024 / 1024:.1f} MB (still above target)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
