"""End-to-end smoke test for the deployed `wassel-video-cv` service.

    set MODAL_CV_URL=https://r-abanumay--wassel-video-cv.modal.run
    set MODAL_CV_TOKEN=...
    python infra/modal/video-cv/smoke.py --video-url <stored competitor mp4> [--keep]

Calls /healthz, /embed_query, /embed_text, /embed_images, then /process on the
given video with a fresh random UUID, validates the manifest against the
contract (§2), verifies every frame was uploaded to the public bucket, and —
unless --keep — deletes the test prefix so no orphan frames remain. Needs
SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment (or .env.local in
the repo root) for the bucket check + cleanup.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

TRANSITIONS = {"cut", "fade", "dissolve", "graphic", "start", "end"}


def load_env_local() -> None:
    for up in [HERE, *HERE.parents]:
        p = up / ".env.local"
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            return


def check(cond: bool, msg: str) -> None:
    if not cond:
        raise SystemExit(f"FAIL: {msg}")
    print(f"  ok  {msg}")


def validate_manifest(m: dict, video_id: str) -> None:
    v = m["video"]
    check(v["detector_version"] == "psd-adaptive-1", "detector_version")
    check(isinstance(v["embedding_version"], str) and v["embedding_version"], "embedding_version present")
    check(v["duration_ms"] > 0 and v["fps"] > 0 and v["width"] > 0 and v["height"] > 0, "video header numeric")
    shots, frames, groups = m["shots"], m["frames"], m["dup_groups"]
    check(len(shots) >= 1, f"{len(shots)} shots")
    check(len(frames) >= 1, f"{len(frames)} frames")
    ts_set = {f["ts_ms"] for f in frames}
    check(len(ts_set) == len(frames), "frame ts_ms unique")
    for s in shots:
        check(s["transition_in"] in TRANSITIONS and s["transition_out"] in TRANSITIONS, f"shot {s['shot_no']} transitions {s['transition_in']}/{s['transition_out']}")
        check(s["representative_ts_ms"] in ts_set, f"shot {s['shot_no']} representative exists")
        check(all(k in ts_set for k in s["keyframe_ts_ms"]), f"shot {s['shot_no']} keyframes exist")
        check(s["end_ms"] > s["start_ms"], f"shot {s['shot_no']} range")
    check(shots[0]["transition_in"] == "start" and shots[-1]["transition_out"] == "end", "start/end sentinels")
    for f in frames:
        check(f["storage_path"] == f"content/frame/{video_id}/{f['ts_ms']:07d}.webp", f"deterministic path {f['ts_ms']}")
        check(len(f["embedding"]) == 768, "embedding 768-d")
        check(len(f["phash"]) == 64, "phash 16x16 hex")
        check("blur" in f["quality"] and "dark" in f["quality"], "quality keys")
        check(f["dup_group"] >= 0, "dup_group assigned")
    reps = {g["representative_ts_ms"] for g in groups}
    for f in frames:
        if f["ts_ms"] in reps:
            check(f["ocr"] is not None and f["ocr"]["lang"] in ("ar", "en", "mixed", "none"), f"representative {f['ts_ms']} has ocr")
        else:
            check(f["ocr"] is None, f"member {f['ts_ms']} ocr null (inherits in DB)")
    check(sum(g["size"] for g in groups) == len(frames), "dup group sizes sum to frames")
    check(isinstance(m["cost_usd"], (int, float)), "cost_usd numeric")

    # Frame-count sanity: every shot has ≥ 1 frame, and (unless partial) the
    # count is ≈ duration/interval grid + shot boundaries + final frame.
    frame_shots = {f["shot_no"] for f in frames}
    for s in shots:
        check(s["shot_no"] in frame_shots, f"shot {s['shot_no']} has ≥ 1 frame")
    if not m.get("partial"):
        interval = m.get("config", {}).get("frame_interval_ms", 500)
        grid = len(range(0, v["duration_ms"], interval))
        lo, hi = grid - 2, grid + 2 * len(shots) + 4
        check(lo <= len(frames) <= hi, f"frame count {len(frames)} ≈ grid {grid} + boundaries ({len(shots)} shots)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video-url", required=True)
    ap.add_argument("--video-id", default=None, help="UUID to process as (default: fresh random). Pass the real mkt_content_media id when smoke-testing against a stored video.")
    ap.add_argument("--keep", action="store_true", help="do not delete the uploaded test frames")
    ap.add_argument("--async", dest="use_async", action="store_true", help="use the spawn + poll path")
    args = ap.parse_args()
    load_env_local()
    base = os.environ["MODAL_CV_URL"].rstrip("/")
    tok = os.environ["MODAL_CV_TOKEN"]
    h = {"x-wassel-token": tok}
    c = httpx.Client(timeout=httpx.Timeout(1800.0, connect=30.0), follow_redirects=True)

    print("healthz"); r = c.get(f"{base}/healthz", headers=h); check(r.status_code == 200, r.text)
    print("auth");    r = c.get(f"{base}/healthz"); check(r.status_code == 401, "missing token → 401")

    print("embed_query"); t = time.time()
    r = c.post(f"{base}/embed_query", json={"text": "شقة فاخرة بإطلالة على البحر"}, headers=h); check(r.status_code == 200, r.text[:200])
    q = r.json(); check(len(q["image_vec"]) == 768 and len(q["text_vec"]) == 1024, f"embed_query dims ({time.time()-t:.1f}s)")

    print("embed_text"); t = time.time()
    r = c.post(f"{base}/embed_text", json={"texts": ["فيلا في حي الياسمين", "luxury apartment in Riyadh"]}, headers=h); check(r.status_code == 200, r.text[:200])
    e = r.json(); check(e["dim"] == 1024 and len(e["vectors"]) == 2 and len(e["vectors"][0]) == 1024, f"embed_text dims model={e['model']} ({time.time()-t:.1f}s)")

    video_id = args.video_id or str(uuid.uuid4())
    print(f"process video_id={video_id}"); t = time.time()
    body = {"video_id": video_id, "video_url": args.video_url, "config": {"frame_interval_ms": 500, "max_frames": 2000, "min_shot_ms": 250, "ocr": True, "labels": True}}
    if args.use_async:
        r = c.post(f"{base}/process", json={**body, "async": True}, headers=h); check(r.status_code == 200, r.text[:300])
        call_id = r.json()["call_id"]
        while True:
            time.sleep(5)
            r = c.get(f"{base}/process/{call_id}", headers=h); check(r.status_code == 200, r.text[:300])
            if r.json()["status"] == "done":
                m = r.json()["manifest"]; break
    else:
        r = c.post(f"{base}/process", json=body, headers=h); check(r.status_code == 200, r.text[:300])
        m = r.json()
    wall = time.time() - t
    print(f"  process wall {wall:.1f}s timings={m['timings']} cost=${m['cost_usd']} ocr_engine={m['video']['ocr_engine']} partial={m['partial']} warnings={m['warnings']}")
    validate_manifest(m, video_id)
    out = HERE / f"manifest-{video_id[:8]}.json"
    out.write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
    print(f"  manifest written to {out}")

    from storage import Storage

    st = Storage()
    listed = st.list_prefix(f"content/frame/{video_id}")
    names = {o["name"] for o in listed}
    check(names == {f"{f['ts_ms']:07d}.webp" for f in m["frames"]}, f"bucket has exactly the {len(names)} frames")
    r = c.get(m["frames"][0]["public_url"]); check(r.status_code == 200 and r.headers.get("content-type", "").startswith("image/webp"), "public_url serves webp")

    print("embed_images"); t = time.time()
    r = c.post(f"{base}/embed_images", json={"urls": [m["frames"][0]["public_url"]]}, headers=h); check(r.status_code == 200, r.text[:200])
    ei = r.json(); check(ei["dim"] == 768 and len(ei["vectors"]) == 1, f"embed_images ({time.time()-t:.1f}s)")
    import numpy as np
    sim = float(np.dot(ei["vectors"][0], m["frames"][0]["embedding"]))
    check(sim > 0.98, f"embed_images matches process embedding (cos={sim:.4f})")

    if args.keep:
        print(f"keeping content/frame/{video_id}/")
    else:
        st.delete([f"content/frame/{video_id}/{n}" for n in names])
        check(st.list_prefix(f"content/frame/{video_id}") == [], "test frames deleted")
    print("ALL OK")


if __name__ == "__main__":
    main()
