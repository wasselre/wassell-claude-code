"""Modal app `wassel-video-cv` — competitor video → shots / frames / embeddings.

HTTP contract: docs/marketing-script-visual-contracts.md §3 (token header
`x-wassel-token`), manifest contract §2. Deploy: see README.md in this folder.

Layout
  web  (CPU, FastAPI)  ── .remote() ──▶  CV  (T4 GPU class: SigLIP-2 + bge-m3 + OCR)
The web function only validates the token + payload and forwards; every GPU
container loads the models once (`@modal.enter`) from the `wassel-cv-models`
volume and then serves inputs until it scales down.
"""


import modal

APP_NAME = "wassel-video-cv"
BUILD = "2026-09-02.3"
GPU = "T4"
VOLUME_NAME = "wassel-cv-models"
HF_HOME = "/cache/hf"

# Modal list prices (USD) — verify against https://modal.com/pricing when
# changing GPU / cpu / memory; used for the manifest's cost_usd estimate only.
RATES = {
    "gpu_per_s": {"T4": 0.59 / 3600, "L4": 0.80 / 3600, "A10G": 1.10 / 3600, "L40S": 1.95 / 3600},
    "cpu_core_per_s": 0.192 / 3600,
    "mem_gib_per_s": 0.024 / 3600,
}
CPU_CORES = 4.0
MEMORY_MIB = 12288
OCR_REMOTE_SEC_PER_FRAME = 2.5   # rough L40S seconds per frame on wassel-ocr, for the estimate only

app = modal.App(APP_NAME)
models_volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


def _prefetch_paddle_models() -> None:
    """Image-build step: bake the PaddleOCR arabic det/rec models into the image
    so the fallback engine never downloads at request time."""
    from paddleocr import PaddleOCR

    PaddleOCR(lang="ar", use_angle_cls=False, show_log=False, use_gpu=False)


cv_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "libgl1", "libglib2.0-0", "libgomp1", "libsm6", "libxext6")
    .pip_install(
        "numpy==1.26.4",
        "torch==2.5.1",
        "transformers==4.51.3",
        "sentence-transformers==3.4.1",
        "scenedetect==0.6.6",
        "opencv-python-headless==4.10.0.84",
        "pillow==10.4.0",
        "imagehash==4.3.1",
        "httpx==0.27.2",
        "sentencepiece",
        # PaddleOCR fallback — paddleocr itself is installed --no-deps below so
        # it cannot drag in opencv-python + opencv-contrib-python next to headless.
        "paddlepaddle==3.0.0",
        "shapely", "scikit-image", "pyclipper", "lmdb", "tqdm", "rapidfuzz", "pyyaml",
        "python-docx", "beautifulsoup4", "fonttools>=4.24.0", "fire>=0.3.0", "requests",
        "albumentations", "albucore", "cython",
    )
    .pip_install("paddleocr==2.10.0", extra_options="--no-deps")
    .env({"HF_HOME": HF_HOME, "TOKENIZERS_PARALLELISM": "false", "PYTHONUNBUFFERED": "1"})
    .run_function(_prefetch_paddle_models)
    .add_local_python_source("detect", "frames", "embed", "ocr", "storage", "labels")
)

web_image = modal.Image.debian_slim(python_version="3.11").pip_install("fastapi[standard]==0.115.12")


def _log(msg: str) -> None:
    print(msg, flush=True)


@app.cls(
    gpu=GPU,
    image=cv_image,
    volumes={"/cache": models_volume},
    secrets=[modal.Secret.from_name("wassel-supabase")],
    timeout=60 * 60,
    scaledown_window=300,
    cpu=CPU_CORES,
    memory=MEMORY_MIB,
    max_containers=8,
)
class CV:
    @modal.enter()
    def load(self) -> None:
        import time

        from embed import Embedder
        from ocr import OCREngine
        from storage import Storage

        t0 = time.time()
        self.embedder = Embedder()
        self.embedder.label_bank()          # warm the zero-shot prompt bank
        models_volume.commit()              # persist freshly downloaded weights (no-op when cached)
        self.ocr = OCREngine(log=_log)
        self.storage = Storage()
        _log(f"[cv] models ready in {time.time() - t0:.1f}s device={self.embedder.device}")

    # ── /process ────────────────────────────────────────────────────────────
    @modal.method()
    def process(self, video_id: str, video_url: str, config: dict | None = None) -> dict:
        import os
        import subprocess
        import tempfile
        import time

        import numpy as np

        from detect import DETECTOR_VERSION, detect_cuts
        from embed import BGE_VERSION, EMBEDDING_VERSION, SIGLIP_ID, round_vec
        from frames import (assign_shots, build_shots, dup_groups, extract, plan_targets, refine_graphic, select_keyframes)
        from storage import frame_path, public_url

        t_start = time.time()
        timings: dict[str, float] = {}
        warnings: list[str] = []
        cfg = {"frame_interval_ms": 500, "max_frames": 2000, "min_shot_ms": 250, "ocr": True, "labels": True}
        cfg.update({k: v for k, v in (config or {}).items() if v is not None})

        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, "src.mp4")
            t = time.time()
            src_bytes, src_sha = self.storage.download(video_url, src)
            timings["download_s"] = round(time.time() - t, 2)
            _log(f"[cv] {video_id} downloaded {src_bytes} bytes sha={src_sha[:12]}")

            # ── shot detection ─────────────────────────────────────────────
            t = time.time()
            try:
                info, cuts = detect_cuts(src, cfg["min_shot_ms"])
            except Exception as e:
                # Some containers/codecs defeat the OpenCV backend; normalise with ffmpeg once and retry.
                _log(f"[cv] detect failed ({e!r}); transcoding with ffmpeg and retrying")
                norm = os.path.join(td, "norm.mp4")
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-c:v", "libx264", "-preset", "veryfast", "-an", norm], check=True)
                src = norm
                warnings.append(f"source transcoded with ffmpeg before analysis: {e!r}")
                info, cuts = detect_cuts(src, cfg["min_shot_ms"])
            timings["detect_s"] = round(time.time() - t, 2)
            _log(f"[cv] {video_id} fps={info.fps:.3f} est_frames={info.frame_count} cuts={len(cuts)}")

            # ── frame extraction (single decode pass) ──────────────────────
            t = time.time()
            est_count = info.frame_count if info.frame_count > 0 else max(cuts + [0]) + 1
            targets, boundary_idxs, partial, partial_reason = plan_targets(est_count, info.fps, cuts, cfg["frame_interval_ms"], cfg["max_frames"])
            frames, luma, diff, n_decoded, width, height = extract(src, info.fps, targets, keep_last=True)
            timings["extract_s"] = round(time.time() - t, 2)
            if n_decoded != est_count:
                _log(f"[cv] {video_id} decoded {n_decoded} frames (stream header said {est_count})")
            cuts = [c for c in cuts if 0 < c < n_decoded]
            frames = [f for f in frames if f.idx < n_decoded]
            frames.sort(key=lambda f: f.idx)
            shots = build_shots(n_decoded, info.fps, cuts, luma, diff)
            boundary_idxs = {s.start_idx for s in shots} | {s.end_idx - 1 for s in shots}
            assign_shots(frames, shots, boundary_idxs)
            refine_graphic(shots, {f.idx: f for f in frames})
            duration_ms = int(round(n_decoded * 1000.0 / info.fps))

            # ── embeddings ─────────────────────────────────────────────────
            t = time.time()
            vecs = self.embedder.image_vectors_from_bytes(f.webp for f in frames)
            for f, v in zip(frames, vecs):
                f.embedding = v
            timings["embed_s"] = round(time.time() - t, 2)

            select_keyframes(shots, frames)
            groups = dup_groups(frames)

            # ── zero-shot labels ───────────────────────────────────────────
            if cfg["labels"]:
                t = time.time()
                for f, labs in zip(frames, self.embedder.zero_shot_labels(vecs)):
                    f.labels = labs
                timings["labels_s"] = round(time.time() - t, 2)

            # ── OCR on dup-group representatives only ──────────────────────
            ocr_engine = "skipped"
            n_ocr = 0
            if cfg["ocr"]:
                t = time.time()
                by_ts = {f.ts_ms: f for f in frames}
                reps = [by_ts[g["representative_ts_ms"]] for g in groups]
                results, ocr_engine = self.ocr.run([r.webp for r in reps], warnings)
                for r, res in zip(reps, results):
                    r.ocr = res
                n_ocr = len(reps)
                timings["ocr_s"] = round(time.time() - t, 2)
                _log(f"[cv] {video_id} ocr engine={ocr_engine} frames={n_ocr}")

            # ── upload (deterministic paths, upsert) ───────────────────────
            t = time.time()
            self.storage.upload_many([(frame_path(video_id, f.ts_ms), f.webp) for f in frames])
            timings["upload_s"] = round(time.time() - t, 2)

        # ── cost estimate ──────────────────────────────────────────────────
        elapsed = time.time() - t_start
        gpu_cost = elapsed * (RATES["gpu_per_s"][GPU] + CPU_CORES * RATES["cpu_core_per_s"] + (MEMORY_MIB / 1024.0) * RATES["mem_gib_per_s"])
        ocr_cost = (n_ocr * OCR_REMOTE_SEC_PER_FRAME * RATES["gpu_per_s"]["L40S"]) if ocr_engine.startswith("wassel-ocr") else 0.0
        cost_usd = round(gpu_cost + ocr_cost, 5)
        timings["total_s"] = round(elapsed, 2)

        manifest = {
            "video": {
                "video_id": video_id,
                "source_url": video_url,
                "source_sha256": src_sha,
                "source_bytes": src_bytes,
                "duration_ms": duration_ms,
                "fps": round(info.fps, 3),
                "width": width,
                "height": height,
                "frame_count_decoded": n_decoded,
                "detector_version": DETECTOR_VERSION,
                "embedding_version": EMBEDDING_VERSION,
                "embedding_model": SIGLIP_ID,
                "text_embedding_version": BGE_VERSION,
                "ocr_engine": ocr_engine,
            },
            "shots": [
                {
                    "shot_no": s.shot_no, "start_ms": s.start_ms, "end_ms": s.end_ms,
                    "transition_in": s.transition_in, "transition_out": s.transition_out,
                    "is_static": s.is_static, "internal_change": s.internal_change,
                    "representative_ts_ms": s.representative_ts_ms, "keyframe_ts_ms": s.keyframe_ts_ms,
                }
                for s in shots
            ],
            "frames": [
                {
                    "ts_ms": f.ts_ms, "frame_no": i, "source_frame_idx": f.idx, "shot_no": f.shot_no,
                    "is_boundary": f.is_boundary, "phash": f.phash, "dup_group": f.dup_group,
                    "storage_path": frame_path(video_id, f.ts_ms),
                    "public_url": public_url(self.storage.base_url, frame_path(video_id, f.ts_ms)),
                    "width": f.width, "height": f.height, "bytes": len(f.webp),
                    "quality": f.quality, "ocr": f.ocr, "labels": f.labels,
                    "embedding": round_vec(np.asarray(f.embedding)),
                }
                for i, f in enumerate(frames)
            ],
            "dup_groups": groups,
            "cost_usd": cost_usd,
            "cost_breakdown": {"gpu_type": GPU, "gpu_seconds": round(elapsed, 2), "container_usd": round(gpu_cost, 5), "ocr_remote_usd_estimate": round(ocr_cost, 5)},
            "config": cfg,
            "timings": timings,
            "partial": partial,
            "partial_reason": partial_reason,
            "warnings": warnings,
        }
        _log(f"[cv] {video_id} done shots={len(shots)} frames={len(frames)} groups={len(groups)} in {elapsed:.1f}s cost≈${cost_usd}")
        return manifest

    # ── embeddings ──────────────────────────────────────────────────────────
    @modal.method()
    def embed_text(self, texts: list[str]) -> dict:
        from embed import BGE_DIM, BGE_ID, BGE_VERSION, round_vec

        vecs = self.embedder.bge_vectors(texts)
        return {"model": BGE_ID, "version": BGE_VERSION, "dim": BGE_DIM, "vectors": [round_vec(v, 6) for v in vecs]}

    @modal.method()
    def embed_query(self, text: str) -> dict:
        from embed import BGE_ID, BGE_VERSION, EMBEDDING_VERSION, SIGLIP_ID, round_vec

        iv = self.embedder.siglip_text_vectors([text])[0]
        tv = self.embedder.bge_vectors([text])[0]
        return {
            "image_vec": round_vec(iv, 6), "text_vec": round_vec(tv, 6),
            "image_model": SIGLIP_ID, "image_version": EMBEDDING_VERSION, "text_model": BGE_ID, "text_version": BGE_VERSION,
        }

    @modal.method()
    def embed_images(self, urls: list[str]) -> dict:
        import io

        import httpx
        from PIL import Image

        from embed import EMBEDDING_VERSION, SIGLIP_DIM, SIGLIP_ID, round_vec

        images = []
        with httpx.Client(timeout=httpx.Timeout(60.0, connect=15.0), follow_redirects=True) as client:
            for u in urls:
                r = client.get(u)
                if r.status_code != 200:
                    raise RuntimeError(f"embed_images: HTTP {r.status_code} for {u}")
                try:
                    images.append(Image.open(io.BytesIO(r.content)).convert("RGB"))
                except Exception as e:
                    raise RuntimeError(f"embed_images: undecodable image at {u}: {e!r}") from e
        vecs = self.embedder.image_vectors(images)
        return {"model": SIGLIP_ID, "version": EMBEDDING_VERSION, "dim": SIGLIP_DIM, "vectors": [round_vec(v, 6) for v in vecs]}


# ── HTTP surface ────────────────────────────────────────────────────────────
@app.function(image=web_image, secrets=[modal.Secret.from_name("wassel-cv-token")], timeout=60 * 60)
@modal.concurrent(max_inputs=64)
@modal.asgi_app(label="wassel-video-cv")
def web():
    import hmac
    import os
    import re

    from fastapi import Depends, FastAPI, Header, HTTPException
    from pydantic import BaseModel, Field

    UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
    expected = os.environ["MODAL_CV_TOKEN"]

    def auth(x_wassel_token: str | None = Header(default=None)) -> None:
        if not x_wassel_token or not hmac.compare_digest(x_wassel_token, expected):
            raise HTTPException(status_code=401, detail="bad or missing x-wassel-token")

    class ProcessConfig(BaseModel):
        frame_interval_ms: int = Field(500, ge=100, le=10000)
        max_frames: int = Field(2000, ge=1, le=20000)
        min_shot_ms: int = Field(250, ge=40, le=10000)
        ocr: bool = True
        labels: bool = True

    class ProcessBody(BaseModel):
        video_id: str
        video_url: str
        config: ProcessConfig = ProcessConfig()
        async_: bool = Field(False, alias="async")
        model_config = {"populate_by_name": True}

    class TextsBody(BaseModel):
        texts: list[str] = Field(..., min_length=1, max_length=512)

    class QueryBody(BaseModel):
        text: str = Field(..., min_length=1)

    class UrlsBody(BaseModel):
        urls: list[str] = Field(..., min_length=1, max_length=128)

    api = FastAPI(title=APP_NAME, dependencies=[Depends(auth)])

    def _validate(body: ProcessBody) -> None:
        if not UUID_RE.match(body.video_id):
            raise HTTPException(status_code=422, detail="video_id must be a UUID")
        if not body.video_url.startswith(("http://", "https://")):
            raise HTTPException(status_code=422, detail="video_url must be http(s)")

    @api.get("/healthz")
    def healthz() -> dict:
        return {"ok": True, "app": APP_NAME, "gpu": GPU, "build": BUILD}

    @api.post("/process")
    async def process(body: ProcessBody) -> dict:
        _validate(body)
        cfg = body.config.model_dump()
        if body.async_:
            call = CV().process.spawn(body.video_id, body.video_url, cfg)
            return {"status": "queued", "call_id": call.object_id}
        return await CV().process.remote.aio(body.video_id, body.video_url, cfg)

    @api.get("/process/{call_id}")
    async def process_status(call_id: str) -> dict:
        call = modal.FunctionCall.from_id(call_id)
        try:
            result = await call.get.aio(timeout=0)
        except TimeoutError:
            return {"status": "pending", "call_id": call_id}
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"process failed: {e!r}")
        return {"status": "done", "call_id": call_id, "manifest": result}

    @api.post("/embed_text")
    async def embed_text(body: TextsBody) -> dict:
        return await CV().embed_text.remote.aio(body.texts)

    @api.post("/embed_query")
    async def embed_query(body: QueryBody) -> dict:
        return await CV().embed_query.remote.aio(body.text)

    @api.post("/embed_images")
    async def embed_images(body: UrlsBody) -> dict:
        return await CV().embed_images.remote.aio(body.urls)

    return api
