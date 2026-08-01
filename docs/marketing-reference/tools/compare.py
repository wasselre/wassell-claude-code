#!/usr/bin/env python3
"""compare.py — pixel + SSIM comparison for the Marketing OS visual gate.

Usage:
    python compare.py <reference.png> <actual.png> <overlay_out.png> <diff_out.png> [masks_json]

- Both images loaded as RGB numpy arrays. If dimensions differ, prints
  {"dim_match": false, ...} and exits 0 — the harness fails the row.
  NO resizing / aligning / warping, ever.
- masks_json (optional) is an inline JSON list of {"x","y","w","h"} rects,
  painted constant mid-gray in BOTH images before comparison. Only used
  where the reference itself shows placeholder media.
- SSIM: skimage.metrics.structural_similarity, channel_axis=2, data_range 255.
- Pixel diff: per-pixel max-channel abs delta; a pixel "differs" if > 25
  (anti-aliasing tolerance). pixel_pct = 100 * (1 - differing/total).
- Overlay: reference at 50% alpha over the actual.
- Diff: differing pixels in red over a desaturated actual.
- Prints ONE JSON line on success:
  {"dim_match": true, "ssim": 0.9x, "pixel_pct": 99.x, "width": w, "height": h}
"""
import json
import sys

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity

PIXEL_TOLERANCE = 25
MASK_GRAY = 128


def main() -> int:
    if len(sys.argv) < 5:
        print("usage: compare.py <reference.png> <actual.png> <overlay_out.png> <diff_out.png> [masks_json]",
              file=sys.stderr)
        return 2

    ref_path, actual_path, overlay_out, diff_out = sys.argv[1:5]
    masks = json.loads(sys.argv[5]) if len(sys.argv) > 5 else []

    ref_img = Image.open(ref_path).convert("RGB")
    actual_img = Image.open(actual_path).convert("RGB")

    if ref_img.size != actual_img.size:
        print(json.dumps({
            "dim_match": False,
            "ref": [ref_img.size[0], ref_img.size[1]],
            "actual": [actual_img.size[0], actual_img.size[1]],
        }))
        return 0

    ref = np.asarray(ref_img, dtype=np.uint8).copy()
    actual = np.asarray(actual_img, dtype=np.uint8).copy()
    height, width = ref.shape[:2]

    for m in masks:
        x0 = max(0, int(m["x"]))
        y0 = max(0, int(m["y"]))
        x1 = min(width, x0 + int(m["w"]))
        y1 = min(height, y0 + int(m["h"]))
        if x1 <= x0 or y1 <= y0:
            continue
        ref[y0:y1, x0:x1] = MASK_GRAY
        actual[y0:y1, x0:x1] = MASK_GRAY

    ssim = structural_similarity(ref, actual, channel_axis=2, data_range=255)

    delta = np.abs(ref.astype(np.int16) - actual.astype(np.int16)).max(axis=2)
    differing = delta > PIXEL_TOLERANCE
    total = width * height
    pixel_pct = 100.0 * (1.0 - float(differing.sum()) / float(total))

    # Overlay: reference at 50% alpha over the actual.
    overlay = Image.blend(Image.fromarray(actual), Image.fromarray(ref), 0.5)
    overlay.save(overlay_out)

    # Diff: red differing pixels over a desaturated actual.
    gray = Image.fromarray(actual).convert("L").convert("RGB")
    diff_arr = np.asarray(gray, dtype=np.uint8).copy()
    diff_arr[differing] = (255, 0, 0)
    Image.fromarray(diff_arr).save(diff_out)

    print(json.dumps({
        "dim_match": True,
        "ssim": round(float(ssim), 6),
        "pixel_pct": round(pixel_pct, 4),
        "width": width,
        "height": height,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
