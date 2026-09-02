# wassel-video-cv — Modal service for competitor visual intelligence

Turns one stored competitor video into shots, frames (uploaded to the public
`marketing-assets` bucket), SigLIP-2 embeddings, zero-shot labels, phash dup
groups and OCR, returned as ONE manifest the Fly worker feeds to
`mkt_cv_ingest_manifest` → `mkt_cv_ingest_frames` (chunks of ≤ 200) →
`mkt_cv_finalize_video`. Contract: `docs/marketing-script-visual-contracts.md`
§2 (manifest), §3 (HTTP), §6 (label vocabulary).

Why Modal and not Fly: the Fly org is blocked from GPU machines (see the
`project_modal_gpu_ocr` memory note); the existing `wassel-ocr` app already
lives here and is reused for OCR.

## Files

| File | What |
| --- | --- |
| `app.py` | Modal app: image, GPU class `CV` (models loaded once per container), FastAPI `web` endpoint, cost estimate |
| `detect.py` | PySceneDetect `AdaptiveDetector` (cuts) + `ThresholdDetector` (fades) → cut frame indices; `DETECTOR_VERSION = psd-adaptive-1` |
| `frames.py` | one-pass OpenCV decode: per-frame stats, grid + boundary grab, webp q80 / long side 512, phash 16×16, blur/dark, transition classes, dup groups (Hamming ≤ 6), keyframes (medoid ± first/last), `is_static`, `internal_change` |
| `embed.py` | SigLIP-2 image/text (768-d) + bge-m3 text (1024-d), zero-shot labels; `EMBEDDING_VERSION = siglip2-b16-256-1` |
| `labels.py` | the §6 vocabulary + prompts — **keep identical to `worker/src/marketing/cv/vocab.ts`** |
| `ocr.py` | OCR on dup-group representatives: `wassel-ocr` first, PaddleOCR (`lang=ar`) fallback, per-item |
| `storage.py` | Supabase Storage REST (service role): upsert upload, list, delete, stream download |
| `smoke.py` | end-to-end test against the deployed URL (creates + deletes a test prefix) |

## Deploy

```bash
# Windows: the Modal CLI crashes on progress bars without this
export PYTHONUTF8=1
MODAL=C:/Users/rayan/AppData/Local/Programs/Python/Python312/Scripts/modal   # v1.5.3, profile r-abanumay

# 1. secrets (once; --force to rotate)
$MODAL secret create wassel-cv-token MODAL_CV_TOKEN=$(python -c "import secrets;print(secrets.token_hex(32))") --force
$MODAL secret create wassel-supabase SUPABASE_URL=https://zhqqsxwealdwqzrbpwyv.supabase.co SUPABASE_SERVICE_ROLE_KEY=<service key> --force

# 2. deploy (first build ≈ 10–15 min: torch + paddle image; later deploys reuse layers)
$MODAL deploy infra/modal/video-cv/app.py

# 3. smoke-test (needs SUPABASE_* in env or .env.local for the bucket check + cleanup)
export MODAL_CV_URL=https://r-abanumay--wassel-video-cv.modal.run
export MODAL_CV_TOKEN=<the token>
python infra/modal/video-cv/smoke.py --video-url "<mkt_content_media.stored_url of a video>" \
    --video-id "<that row's id>"   # optional; default is a fresh random UUID
```

The Fly worker needs `MODAL_CV_URL` + `MODAL_CV_TOKEN` (`fly secrets set … -a wassel-deck-worker`).
The token is never committed; it lives in the Modal secret + the worker's secrets
(and should be added to `.env.local` and re-sealed with `scripts/secrets/seal.sh`).

Model weights (≈ 0.4 GB SigLIP-2 + 2.3 GB bge-m3) are cached on the Modal
volume `wassel-cv-models` (`HF_HOME=/cache/hf`); only the first container after
a fresh deploy downloads them. PaddleOCR's arabic det/rec models are baked into
the image at build time (`_prefetch_paddle_models`).

## Endpoints (all require header `x-wassel-token`)

Base URL: `https://r-abanumay--wassel-video-cv.modal.run`

| Method / path | Body | Returns |
| --- | --- | --- |
| `GET /healthz` | — | `{ok, app, gpu}` |
| `POST /process` | `{video_id (uuid), video_url, config:{frame_interval_ms:500, max_frames:2000, min_shot_ms:250, ocr:true, labels:true}}` | the manifest (§2) |
| `POST /process` with `"async": true` | same | `{status:'queued', call_id}` |
| `GET /process/{call_id}` | — | `{status:'pending'}` · `{status:'done', manifest}` · 500 with the error |
| `POST /embed_text` | `{texts:[…]}` (≤ 512) | `{model:'BAAI/bge-m3', version:'bge-m3-1', dim:1024, vectors}` |
| `POST /embed_query` | `{text}` | `{image_vec:[768], text_vec:[1024], image_model, image_version, text_model, text_version}` |
| `POST /embed_images` | `{urls:[…]}` (≤ 128) | `{model:'google/siglip2-base-patch16-256', version:'siglip2-b16-256-1', dim:768, vectors}` |

**Long requests.** A synchronous `/process` that runs past 150 s gets a Modal
`303` redirect to a result URL that blocks until done (up to ~50 min across
redirects). Clients must follow redirects (`curl -L`, `fetch` does by default).
For the worker the `async: true` + `GET /process/{call_id}` path is the safer
choice (no long-held connection, survives worker restarts if the `call_id` is
persisted on the job's `params`).

**Errors** are HTTP 401 (token), 422 (validation), 500 with the Python
exception text (download failure, undecodable video, upload failure after 3
attempts). Nothing is swallowed: OCR engine failures are per-frame
(`ocr.engine='failed'` + an entry in `manifest.warnings`) and never abort the
video.

## Manifest — what each field means

Header `video`: `duration_ms`, `fps`, `width`, `height` (as decoded, rotation
applied), `detector_version`, `embedding_version`, plus extras the worker may
store or ignore: `source_sha256` / `source_bytes` (idempotency key per §3),
`frame_count_decoded`, `embedding_model`, `text_embedding_version`,
`ocr_engine` (`wassel-ocr` · `paddleocr` · `wassel-ocr+paddleocr` · `failed` ·
`skipped`).

`shots[]`: `shot_no`, `start_ms`, `end_ms` (exclusive), `transition_in/out` ∈
`{cut, fade, dissolve, graphic, start, end}`, `is_static`, `internal_change`,
`representative_ts_ms`, `keyframe_ts_ms[]`.

`frames[]`: `ts_ms` (real decode timestamp = `round(idx·1000/fps)`),
`frame_no` (ordinal, what `mkt_cv_ingest_frames` stores), `source_frame_idx`,
`shot_no`, `is_boundary`, `phash` (64 hex = 16×16 DCT hash), `dup_group`,
`storage_path` = `content/frame/<video_id>/<ts_ms:07d>.webp`, `public_url`,
`width`, `height`, `bytes`, `quality`, `ocr`, `labels[]`, `embedding[768]`
(L2-normalised, 5 decimals).

`dup_groups[]`: `{group, representative_ts_ms, members_ts_ms[], size}` —
exactly the shape `mkt_cv_finalize_video` expects.

Top level: `cost_usd`, `cost_breakdown`, `config` (effective), `timings`,
`partial` + `partial_reason`, `warnings[]`.

### Heuristics (all thresholds are module constants)

- **Frame grid**: every `frame_interval_ms` (nearest decoded frame) PLUS the
  first and last frame of every shot, PLUS the very last decoded frame. Shots
  shorter than the grid therefore always get ≥ 1 frame. Over `max_frames`:
  boundaries are kept (thinned evenly only if they alone exceed the budget),
  the grid is spread over the remaining budget, `partial=true` with a reason.
- **Transitions** (from per-frame luma + inter-frame diff at 160 px):
  `fade` = luma < 20 or > 235 within [b−8, b+2]; `dissolve` = the diff is
  elevated (> 40 % of the local peak) on ≥ 3 consecutive frames around the
  boundary and the boundary frame itself is not the single spike; `graphic` =
  the incoming shot's first frame is a flat card (Laplacian variance < 15 and
  not near black/white); else `cut`. First shot `transition_in='start'`, last
  shot `transition_out='end'`.
- **is_static**: mean inter-frame abs diff across the shot < 1.5 (0–255 scale).
- **quality**: `blur = clamp(1 − laplacian_var/300)` (0 sharp → 1 blurry),
  `dark = clamp(1 − mean_luma/128)` (0 mid/bright → 1 black); the raw
  `laplacian_var` / `mean_luma` are included.
- **dup groups**: greedy in ts order, join the earliest group whose
  representative is within Hamming ≤ 6 of the 256-bit phash; representative =
  first frame.
- **keyframes**: medoid of the shot's frame embeddings = representative; the
  first / last frame is added when its cosine distance to the medoid > 0.15;
  `internal_change` = cosine distance(first, last) > 0.15.
- **Zero-shot labels**: for each facet in `shot_size, setting, subject,
  graphic, light`, SigLIP logits (`scale·cos + bias`) over the facet's prompt
  embeddings → softmax within the facet → up to 2 labels with p ≥ 0.2, emitted
  as `facet:label`. `motion`, `purpose`, `reproducibility` are in the vocabulary
  but are NOT zero-shot-labelled (not visible in a still) — the LLM shot
  analyzer owns them.
- **OCR**: representatives only. `wassel-ocr` (`modal.Cls.from_name('wassel-ocr','OCR')().parse.map(pngs, return_exceptions=True)`)
  → per-item PaddleOCR fallback. `lang` ∈ `ar | en | mixed | none` from the
  Arabic/Latin letter ratio (`mixed` when the minority script is ≥ 15 %).
  `boxes` is `[]` for `wassel-ocr` (it returns text only) and populated for
  PaddleOCR. Members carry `ocr: null`; the DB finalize step copies the
  representative's OCR into them and stamps `inherited_from`.

## Versions

| Component | Value |
| --- | --- |
| Modal | client 1.5.3, app `wassel-video-cv`, GPU `T4`, 4 CPU / 12 GiB, `scaledown_window=300`, `max_containers=8` |
| Image embeddings | `google/siglip2-base-patch16-256` (768-d), fp16 → `embedding_version = siglip2-b16-256-1` |
| Text embeddings | `BAAI/bge-m3` via sentence-transformers (1024-d, normalised) → `bge-m3-1` |
| Shot detection | PySceneDetect 0.6.6 — `AdaptiveDetector(adaptive_threshold=3.0, min_content_val=15, window_width=2, min_scene_len=0.25 s)` + `ThresholdDetector(threshold=12)`, downscale to ≈ 320 px, `frame_skip=0` → `psd-adaptive-1` |
| Python deps | torch 2.5.1, transformers 4.51.3, sentence-transformers 3.4.1, opencv-python-headless 4.10, pillow 10.4, imagehash 4.3.1, numpy 1.26.4, paddlepaddle 3.0.0 + paddleocr 2.10.0 (`--no-deps`), httpx 0.27.2, fastapi 0.115 |

Bump `DETECTOR_VERSION` / `EMBEDDING_VERSION` whenever a change makes old shots
or vectors incomparable — `mkt_cv_enqueue_video` skips videos already
`frames_done` with the current versions, so a bump is what triggers re-processing.

## Cost

`cost_usd` in the manifest = container wall-seconds × (T4 $0.59/h + 4 cores ×
$0.192/core·h + 12 GiB × $0.024/GiB·h ≈ $0.00043/s) + an ESTIMATE for the
remote `wassel-ocr` L40S time (2.5 s/frame × $1.95/h) when that engine was used.
Rates are the Modal list prices in `RATES` (`app.py`) — re-check
https://modal.com/pricing when changing the GPU. The worker passes this number
to `mkt_cv_finalize_video(p_cost_usd)`, which appends it to the cost ledger
that `cv.daily_budget_usd` is checked against.

Cold start (fresh container, weights from the volume): ~60–90 s. The first
container after a NEW deploy downloads ~2.7 GB of weights once (several
minutes) and commits them to the volume.

Measured on the smoke-test video — see the "Measured" section at the bottom.

## Roll back

- Previous deployment: `modal app history wassel-video-cv` lists versions;
  `modal app rollback wassel-video-cv v<N>` restores one (image + code).
- Kill switch: the worker gates every cv lane on `mkt_settings.cv.enabled`;
  set it to `false` and nothing calls this service. Stopping the app entirely:
  `modal app stop wassel-video-cv` (web URL then returns 404 until redeployed).
- Rotating the token: `modal secret create wassel-cv-token MODAL_CV_TOKEN=<new> --force`
  then redeploy (secrets are read at container start) and update the Fly worker.
- Frames already uploaded are plain objects under `content/frame/<video_id>/`;
  deleting a video's frames = Storage API delete on that prefix (see
  `Storage.delete`) — never a DB trigger.

## Measured (2026-09-02 smoke test)

Filled in after the first live run — see the deployment report in the
coordinator's thread; re-run `smoke.py` to refresh.
