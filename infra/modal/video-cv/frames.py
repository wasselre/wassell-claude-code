"""Frame extraction, per-frame stats, transition classification, phash, quality,
dup groups and keyframe selection.

One sequential decode pass over the video (OpenCV) does three things at once:
  1. per-frame stats for EVERY frame (mean luma + mean abs diff to the previous
     frame at ~160 px) — used to classify transitions and `is_static`;
  2. grabs the target frames: the 500 ms grid (`frame_interval_ms`) PLUS the
     first and last frame of every shot, so shots shorter than the grid still
     get a frame;
  3. encodes each grabbed frame to webp q80 / long side 512, computes its
     phash (16x16 → 64-hex) and blur/dark quality scores.

`ts_ms` of a frame is its REAL decode timestamp (round(idx * 1000 / fps)),
which is what makes `content/frame/<video_id>/<ts_ms:07d>.webp` deterministic
for a given source file + detector version.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass, field

import cv2
import imagehash
import numpy as np
from PIL import Image

LONG_SIDE = 512
WEBP_QUALITY = 80
STATS_WIDTH = 160
PHASH_SIZE = 16
DUP_HAMMING = 6
BLUR_LAPLACIAN_REF = 300.0   # variance of Laplacian at which a 512px frame counts as perfectly sharp
STATIC_DIFF_MAX = 1.5        # mean abs inter-frame diff (0-255, 160px) below which a shot is static
KEYFRAME_COS_DIST = 0.15     # first/last frame becomes an extra keyframe when farther than this from the medoid
INTERNAL_CHANGE_COS_DIST = 0.15


@dataclass
class Frame:
    idx: int
    ts_ms: int
    is_boundary: bool
    webp: bytes
    width: int
    height: int
    phash: str
    phash_obj: imagehash.ImageHash
    quality: dict
    shot_no: int = -1
    dup_group: int = -1
    embedding: list[float] | None = None
    labels: list[str] = field(default_factory=list)
    ocr: dict | None = None


@dataclass
class Shot:
    shot_no: int
    start_idx: int
    end_idx: int   # exclusive
    start_ms: int
    end_ms: int
    transition_in: str = "cut"
    transition_out: str = "cut"
    is_static: bool = False
    internal_change: bool = False
    representative_ts_ms: int | None = None
    keyframe_ts_ms: list[int] = field(default_factory=list)


def ts_of(idx: int, fps: float) -> int:
    return int(round(idx * 1000.0 / fps))


def plan_targets(frame_count: int, fps: float, cuts: list[int], interval_ms: int, max_frames: int) -> tuple[set[int], set[int], bool, str | None]:
    """Decide which frame indices to grab. Returns (targets, boundary_idxs, partial, reason)."""
    starts = [0] + [c for c in cuts if 0 < c < frame_count]
    ends = starts[1:] + [frame_count]
    boundary: set[int] = set()
    for s, e in zip(starts, ends):
        boundary.add(s)
        boundary.add(max(s, e - 1))
    step_frames = max(1, interval_ms / 1000.0 * fps)
    grid = {int(round(k * step_frames)) for k in range(int(math.floor((frame_count - 1) / step_frames)) + 1)}
    grid = {g for g in grid if g < frame_count}
    targets = boundary | grid
    if len(targets) <= max_frames:
        return targets, boundary, False, None

    # Over budget: keep boundaries first (thinned evenly if they alone exceed the
    # budget), then spread the remaining budget over the grid.
    b_sorted = sorted(boundary)
    if len(b_sorted) > max_frames:
        stride = len(b_sorted) / max_frames
        kept = {b_sorted[int(i * stride)] for i in range(max_frames)}
        reason = f"max_frames={max_frames} exceeded by shot boundaries alone ({len(b_sorted)}); boundaries thinned, grid dropped"
        return kept, kept, True, reason
    budget = max_frames - len(b_sorted)
    g_sorted = sorted(grid - boundary)
    if budget > 0 and g_sorted:
        stride = len(g_sorted) / budget
        kept_grid = {g_sorted[int(i * stride)] for i in range(min(budget, len(g_sorted)))}
    else:
        kept_grid = set()
    reason = f"max_frames={max_frames} exceeded (wanted {len(targets)}); grid spread to {len(kept_grid)} + {len(b_sorted)} boundary frames"
    return set(b_sorted) | kept_grid, boundary, True, reason


def _encode(frame_bgr: np.ndarray) -> tuple[bytes, int, int, Image.Image]:
    h, w = frame_bgr.shape[:2]
    scale = LONG_SIDE / float(max(w, h))
    if scale < 1.0:
        nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
        small = cv2.resize(frame_bgr, (nw, nh), interpolation=cv2.INTER_AREA)
    else:
        small = frame_bgr
    rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
    pil = Image.fromarray(rgb)
    buf = io.BytesIO()
    pil.save(buf, format="WEBP", quality=WEBP_QUALITY, method=4)
    return buf.getvalue(), pil.width, pil.height, pil


def _quality(small_bgr: np.ndarray) -> dict:
    gray = cv2.cvtColor(small_bgr, cv2.COLOR_BGR2GRAY)
    lap_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    mean_luma = float(gray.mean())
    blur = float(min(1.0, max(0.0, 1.0 - lap_var / BLUR_LAPLACIAN_REF)))
    dark = float(min(1.0, max(0.0, 1.0 - mean_luma / 128.0)))
    return {
        "blur": round(blur, 4),
        "dark": round(dark, 4),
        "laplacian_var": round(lap_var, 2),
        "mean_luma": round(mean_luma, 2),
    }


def _grab(idx: int, fps: float, bgr: np.ndarray) -> Frame:
    webp, fw, fh, pil = _encode(bgr)
    small_bgr = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    ph = imagehash.phash(pil, hash_size=PHASH_SIZE)
    return Frame(
        idx=idx, ts_ms=ts_of(idx, fps), is_boundary=False, webp=webp, width=fw, height=fh,
        phash=str(ph), phash_obj=ph, quality=_quality(small_bgr),
    )


def extract(path: str, fps: float, targets: set[int], keep_last: bool = True) -> tuple[list[Frame], np.ndarray, np.ndarray, int, int, int]:
    """Single decode pass. Returns (frames, luma[], diff[], frame_count, width, height).

    `keep_last` also grabs the very last decoded frame when it was not a
    planned target — the stream header's frame count is only an estimate, and
    the final shot's last frame must exist regardless."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError(f"extract: cannot open {path}")
    lumas: list[float] = []
    diffs: list[float] = []
    prev_small: np.ndarray | None = None
    frames: list[Frame] = []
    idx = 0
    width = height = 0
    last_bgr: np.ndarray | None = None
    last_grabbed = -1
    try:
        while True:
            ok, bgr = cap.read()
            if not ok or bgr is None:
                break
            if idx == 0:
                height, width = bgr.shape[:2]
            h, w = bgr.shape[:2]
            sw = STATS_WIDTH
            sh = max(1, int(round(h * sw / float(w))))
            small_gray = cv2.cvtColor(cv2.resize(bgr, (sw, sh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
            lumas.append(float(small_gray.mean()))
            diffs.append(0.0 if prev_small is None else float(np.abs(small_gray - prev_small).mean()))
            prev_small = small_gray
            if idx in targets:
                frames.append(_grab(idx, fps, bgr))
                last_grabbed = idx
            last_bgr = bgr
            idx += 1
    finally:
        cap.release()
    if idx == 0:
        raise RuntimeError(f"extract: decoded zero frames from {path}")
    if keep_last and last_bgr is not None and last_grabbed != idx - 1:
        frames.append(_grab(idx - 1, fps, last_bgr))
    return frames, np.asarray(lumas, dtype=np.float32), np.asarray(diffs, dtype=np.float32), idx, width, height


def build_shots(frame_count: int, fps: float, cuts: list[int], luma: np.ndarray, diff: np.ndarray) -> list[Shot]:
    starts = [0] + [c for c in cuts if 0 < c < frame_count]
    ends = starts[1:] + [frame_count]
    shots: list[Shot] = []
    for n, (s, e) in enumerate(zip(starts, ends)):
        shots.append(Shot(shot_no=n, start_idx=s, end_idx=e, start_ms=ts_of(s, fps), end_ms=ts_of(e, fps)))
    # transitions
    for i, sh in enumerate(shots):
        sh.transition_in = "start" if i == 0 else classify_transition(sh.start_idx, luma, diff)
        sh.transition_out = "end" if i == len(shots) - 1 else classify_transition(shots[i + 1].start_idx, luma, diff)
        seg = diff[sh.start_idx + 1 : sh.end_idx]
        sh.is_static = bool(seg.size == 0 or float(seg.mean()) < STATIC_DIFF_MAX)
    return shots


def classify_transition(b: int, luma: np.ndarray, diff: np.ndarray) -> str:
    """Classify the boundary starting at frame b: fade / dissolve / graphic / cut."""
    n = len(luma)
    lo, hi = max(0, b - 8), min(n, b + 3)
    win_luma = luma[lo:hi]
    if win_luma.size and (float(win_luma.min()) < 20.0 or float(win_luma.max()) > 235.0):
        return "fade"
    lo2, hi2 = max(1, b - 5), min(n, b + 6)
    win = diff[lo2:hi2]
    if win.size >= 3:
        peak = float(win.max())
        if peak > 0:
            elevated = int((win > 0.4 * peak).sum())
            if elevated >= 3 and float(diff[b]) < 0.8 * peak:
                return "dissolve"
    # graphic: the new shot opens on a flat card (very low texture, not black/white)
    # — decided from the luma alone at this granularity; refined by the frame's
    # own quality in `refine_graphic` once the boundary frame is encoded.
    return "cut"


def refine_graphic(shots: list[Shot], frames_by_idx: dict[int, Frame]) -> None:
    """Mark a cut as 'graphic' when the incoming shot's first frame is a flat
    card (very low Laplacian variance AND not near-black)."""
    for i, sh in enumerate(shots):
        if i == 0:
            continue
        f = frames_by_idx.get(sh.start_idx)
        if f is None or sh.transition_in != "cut":
            continue
        q = f.quality
        if q["laplacian_var"] < 15.0 and 30.0 < q["mean_luma"] < 235.0:
            sh.transition_in = "graphic"
            shots[i - 1].transition_out = "graphic"


def assign_shots(frames: list[Frame], shots: list[Shot], boundary_idxs: set[int]) -> None:
    j = 0
    for f in sorted(frames, key=lambda x: x.idx):
        while j + 1 < len(shots) and f.idx >= shots[j].end_idx:
            j += 1
        f.shot_no = shots[j].shot_no
        f.is_boundary = f.idx in boundary_idxs


def dup_groups(frames: list[Frame]) -> list[dict]:
    """Greedy grouping by phash Hamming distance <= DUP_HAMMING against each
    group's representative (the earliest frame). Deterministic in ts order."""
    reps: list[Frame] = []                       # representative per group (index = group_no)
    rep_bits: list[np.ndarray] = []              # packed 256-bit hashes of the representatives
    members: dict[int, list[int]] = {}
    for f in sorted(frames, key=lambda x: x.ts_ms):
        bits = np.packbits(f.phash_obj.hash.flatten())
        g = -1
        if rep_bits:
            dist = np.unpackbits(np.bitwise_xor(np.stack(rep_bits), bits), axis=1).sum(axis=1)
            hits = np.nonzero(dist <= DUP_HAMMING)[0]
            if hits.size:
                g = int(hits[0])                 # earliest matching group wins (deterministic)
        if g < 0:
            g = len(reps)
            reps.append(f)
            rep_bits.append(bits)
            members[g] = []
        f.dup_group = g
        members[g].append(f.ts_ms)
    return [
        {"group": g, "representative_ts_ms": rep.ts_ms, "members_ts_ms": members[g], "size": len(members[g])}
        for g, rep in enumerate(reps)
    ]


def _cos_dist(a: np.ndarray, b: np.ndarray) -> float:
    return float(1.0 - np.dot(a, b))


def select_keyframes(shots: list[Shot], frames: list[Frame]) -> None:
    """Medoid of the shot's (normalised) embeddings = representative; first/last
    frame added when farther than KEYFRAME_COS_DIST from the medoid;
    internal_change = first↔last cosine distance > INTERNAL_CHANGE_COS_DIST."""
    by_shot: dict[int, list[Frame]] = {}
    for f in frames:
        by_shot.setdefault(f.shot_no, []).append(f)
    for sh in shots:
        fs = sorted(by_shot.get(sh.shot_no, []), key=lambda x: x.idx)
        if not fs:
            continue
        embs = np.asarray([f.embedding for f in fs], dtype=np.float32)
        if len(fs) == 1:
            sh.representative_ts_ms = fs[0].ts_ms
            sh.keyframe_ts_ms = [fs[0].ts_ms]
            continue
        sims = embs @ embs.T
        medoid_i = int(np.argmax(sims.sum(axis=1)))
        med = embs[medoid_i]
        keys = {fs[medoid_i].ts_ms}
        if _cos_dist(embs[0], med) > KEYFRAME_COS_DIST:
            keys.add(fs[0].ts_ms)
        if _cos_dist(embs[-1], med) > KEYFRAME_COS_DIST:
            keys.add(fs[-1].ts_ms)
        sh.representative_ts_ms = fs[medoid_i].ts_ms
        sh.keyframe_ts_ms = sorted(keys)
        sh.internal_change = _cos_dist(embs[0], embs[-1]) > INTERNAL_CHANGE_COS_DIST
