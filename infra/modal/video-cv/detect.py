"""Shot detection — PySceneDetect AdaptiveDetector (cuts) + ThresholdDetector (fades).

Output is a list of cut frame indices; `frames.py` turns them into shots once it
has the per-frame stats (luma / inter-frame diff) that classify transitions.

DETECTOR_VERSION is written into the manifest header and stored on
`mkt_cv_videos.detector_version`; bump it whenever the parameters below change
so the worker can tell stale shot lists from current ones.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

DETECTOR_VERSION = "psd-adaptive-1"

# Parameters (kept as module constants so the README can quote them).
ADAPTIVE_THRESHOLD = 3.0       # AdaptiveDetector ratio threshold
ADAPTIVE_MIN_CONTENT_VAL = 15.0
ADAPTIVE_WINDOW = 2
FADE_THRESHOLD = 12.0          # ThresholdDetector: avg pixel value under which a frame is "black"
TARGET_WIDTH = 320             # downscale target for detection


@dataclass
class VideoInfo:
    fps: float
    frame_count: int
    width: int
    height: int
    duration_ms: int


def detect_cuts(path: str, min_shot_ms: int = 250) -> tuple[VideoInfo, list[int]]:
    """Return (VideoInfo, sorted list of cut frame indices).

    A cut index `c` means frame `c` is the FIRST frame of the new shot.
    Frame 0 is never a cut; the end of the video is not a cut.
    """
    from scenedetect import SceneManager, open_video
    from scenedetect.detectors import AdaptiveDetector, ThresholdDetector

    video = open_video(path, backend="opencv")
    fps = float(video.frame_rate)
    if not fps or math.isnan(fps) or fps <= 0:
        raise RuntimeError(f"detect: unreadable frame rate for {path}")
    w, h = video.frame_size
    min_len_frames = max(1, int(round(min_shot_ms / 1000.0 * fps)))

    sm = SceneManager()
    sm.auto_downscale = False
    sm.downscale = max(1, int(round(max(w, h) / TARGET_WIDTH)))
    sm.add_detector(
        AdaptiveDetector(
            adaptive_threshold=ADAPTIVE_THRESHOLD,
            min_scene_len=min_len_frames,
            window_width=ADAPTIVE_WINDOW,
            min_content_val=ADAPTIVE_MIN_CONTENT_VAL,
        )
    )
    sm.add_detector(
        ThresholdDetector(threshold=FADE_THRESHOLD, min_scene_len=min_len_frames, add_final_scene=False)
    )
    sm.detect_scenes(video=video, frame_skip=0, show_progress=False)
    cuts = sorted({int(tc.get_frames()) for tc in sm.get_cut_list()})

    # frame_count from the stream (may be an estimate for some containers; the
    # extraction pass re-measures it and the caller reconciles).
    frame_count = int(video.duration.get_frames()) if video.duration is not None else 0
    duration_ms = int(round(frame_count * 1000.0 / fps)) if frame_count else 0
    cuts = [c for c in cuts if 0 < c < max(frame_count, c + 1)]
    return VideoInfo(fps=fps, frame_count=frame_count, width=int(w), height=int(h), duration_ms=duration_ms), cuts
