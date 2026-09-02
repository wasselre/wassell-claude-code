# Script Writer v2 + Competitor Visual Intelligence — Shared Contracts

*Authoritative for every agent on this project. Do not deviate; propose changes to the coordinator. Last updated 2026-09-02.*

This document fixes the database schema, RPC signatures, TypeScript types, endpoint actions, the AI-role adapter, the Modal service contract, job kinds, file ownership and integration order. Migrations `supabase/migrations/2026-09-02_10 … _16` are the schema source of truth and are already applied to `wassell-prod`.

## 0. Non-negotiables (from the approved plan)

- Existing job infrastructure remains (`mos_script_jobs` lane, `notify_emit`, the 4 s poll + progress bar). The writer and the visual system are independent; the writer must work when the visual system is absent.
- Generated scripts are **drafts**; nothing enters `mos_scenes` without human Apply. Protected scenes (manually edited / shoot-linked / production-used) are never removed.
- Project facts (`all_projects` + stored rollups) are the **only** source of factual claims. Competitor content is inspiration. Competitor visual material is `reference_only` and never selectable as a Wassel asset.
- Storage model unchanged: competitor videos stay public in `marketing-assets`; frames go to the same public bucket under `content/frame/`. No signed URLs, no private bucket, no player changes for security.
- AI roles configurable; no model choice is final. Deterministic rules first; model classification only for unresolved claims. Minimise calls.
- No silent catches (repo rule). Record provider, model, version, cost, status on every job/row.
- Every DB write from the browser goes through the API (service client after a capability gate) — new tables have RLS enabled with **no policies**.
- Bilingual UI: `isAr ? ar : en`, never hardcoded strings in JSX (existing MOS pattern uses inline `isAr ? … : …`).

## 1. Schema (applied)

### 1.1 Script writer
- `mos_script_recipes(key pk, label_ar, label_en, structure jsonb[], guidance text, default_duration_sec int, scene_count_hint int, retrieval_content_types text[], requires_facts text[], version int, is_active bool)` — seeded with the five recipes. **Read-only single source.** RLS: SELECT for `authenticated`.
- `mos_script_drafts(id, job_id → mos_script_jobs, content_id → mos_content, recipe, brief jsonb, facts jsonb, exemplars jsonb, plan jsonb, scenes jsonb, hooks jsonb, chosen_hook int, review jsonb, status ('draft'|'needs_attention'|'applied'|'discarded'), applied_scene_ids jsonb, approved_by uuid, applied_at, roles jsonb, cost_usd numeric, created_at, updated_at)`. One active (draft/needs_attention) draft per content: partial unique index.
- `mos_script_jobs` + `draft_id uuid, brief jsonb, stage text, cost_usd numeric, roles jsonb, error_kind text`.
- `mos_scenes` + `source text default 'manual' ('manual'|'ai'), source_draft_id uuid, last_edited_by uuid, manually_edited_at timestamptz, purpose text, visual_intent jsonb, fact_refs jsonb`.
- `mos_script_feedback(id, draft_id, content_id, rating int 1..5, note text, diff jsonb, created_by, created_at)`.
- `mkt_content_embeddings(content_post_id pk → mkt_content_posts, embedding vector(1024), model text, version int, text_hash text, source_text text, created_at)` + HNSW cosine.
- `mos_settings` seeds: `ai_roles` (object keyed by role), `script_writer_rules` (brand/CTA/naming/numeral rules, `allow_developer_name: true`), `script_writer_v2` (`{enabled:true}`) — the v2 flag routes the worker lane; when false the worker falls back to the legacy generator but STILL writes a draft (never `mos_scenes`).

### 1.2 Visual system (`mkt_cv_*`)
- `mkt_cv_videos(id pk, content_media_id unique → mkt_content_media, content_post_id, organization_id, owner ('competitor'|'wassel') default 'competitor', wassel_asset_id uuid null, duration_ms, fps numeric, width, height, status ('queued'|'processing'|'frames_done'|'analyzing'|'analyzed'|'failed'|'partial'), shot_count, frame_count, keyframe_count, detector_version, embedding_version, analysis_version, structure jsonb (video-level derived summary), cost_usd, error, processed_at, analyzed_at, created_at, updated_at)`.
- `mkt_cv_shots(id, video_id, shot_no, start_ms, end_ms, duration_ms, transition_in, transition_out ('cut'|'fade'|'dissolve'|'graphic'|'start'|'end'), is_static, is_micro (<400 ms), internal_change bool, edit_pace_local numeric, representative_frame_id uuid, keyframe_ids jsonb, transcript_text, transcript_segments jsonb, ocr_text, analysis jsonb, tags text[], summary text, embedding_visual vector(768), embedding_text vector(1024), search_tsv tsvector (generated from summary+ocr_text+transcript_text), analysis_status ('pending'|'done'|'failed'), analysis_error, analysis_cost_usd, analysis_role jsonb, created_at, updated_at)`; unique `(video_id, shot_no)`.
- `mkt_cv_frames(id, video_id, shot_id, frame_no, ts_ms, is_boundary, is_keyframe, dup_group_id uuid, phash text, storage_path text, public_url text, width, height, bytes, quality jsonb ({blur, dark, obstruction}), ocr jsonb ({text, lang, boxes[], inherited_from uuid|null}), labels text[], embedding vector(768), analysis jsonb (keyframes + on-demand), described_at, describe_role jsonb, created_at)`; unique `(video_id, ts_ms)`.
- `mkt_cv_dup_groups(id, video_id, representative_frame_id, size int)`.
- `mkt_cv_jobs(id, kind ('cv_process'|'cv_analyze'|'cv_describe_frame'|'cv_embed_wassel'), video_id, frame_id, params jsonb, status ('queued'|'running'|'completed'|'failed'), priority int, attempts, max_attempts 3, worker_id, lease_expires_at, error, result jsonb, created_at, started_at, finished_at)`; partial unique on active `(kind, video_id, frame_id)`.
- `mos_scene_references(id, scene_id → mos_scenes cascade, draft_scene_index int null, content_id, kind ('competitor_shot'|'wassel_asset'|'gap'), ref_id uuid (shot id | mos_assets id | null), frame_url text, open_url text, start_ms, end_ms, reason text, learn_element text, adaptation_notes text, usage_class ('reference_only'|'usable') CHECK (kind<>'competitor_shot' OR usage_class='reference_only'), gap jsonb, rank int, similarity numeric, status ('suggested'|'accepted'|'rejected'), created_by, created_at, updated_at)`.
- Settings (`mkt_settings`): `cv.enabled` (bool, default false until Phase-2 gate passes), `cv.daily_budget_usd` (30), `cv.max_frames_per_video` (2000).

### 1.3 RPCs (SECURITY DEFINER, service_role unless noted)
- `mos_script_job_stage(p_job_id uuid, p_stage text)` → void.
- `mkt_script_exemplars(p_query vector(1024), p_content_types text[], p_platforms text[], p_language text, p_exclude_org uuid, p_limit int)` → rows `(content_post_id, organization_id, org_name, platform, post_type, content_type, language, views bigint, similarity numeric, transcript_text, transcript_segments jsonb, ocr_text, campaign_message, selling_points jsonb, offer, unit_types jsonb, district, published_at, post_url)`. Filters + similarity in SQL; **MMR/diversity in the worker** (`retrieve.ts`).
- `mkt_cv_job_enqueue(p_kind, p_video_id, p_frame_id, p_params, p_priority)` → uuid (dedup on active). `mkt_cv_job_claim_next(p_worker_id, p_kinds text[])` → row. `mkt_cv_job_complete(p_job_id, p_result)`, `mkt_cv_job_fail(p_job_id, p_error)` (requeues while attempts < max), `mkt_cv_jobs_watchdog()` → int.
- `mkt_cv_enqueue_video(p_content_media_id uuid, p_priority int)` → video id (creates `mkt_cv_videos` if absent, enqueues `cv_process` unless already frames_done with the current versions).
- **Chunked ingest** (manifests with thousands of 768-d embeddings must not travel in one call): `mkt_cv_ingest_manifest(p_video_id, p_manifest)` upserts the video header + `shots` (idempotent on `(video_id, shot_no)`, computes `is_micro` and `edit_pace_local`); `mkt_cv_ingest_frames(p_video_id, p_frames jsonb)` upserts a chunk of frames (≤ 200 per call; idempotent on `(video_id, ts_ms)`; shot resolved by `shot_no`); `mkt_cv_finalize_video(p_video_id, p_groups, p_shot_keyframes, p_cost_usd)` writes dup groups (`[{group, representative_ts_ms, members_ts_ms[], size}]`), inherits representative OCR into members, sets shot `representative_frame_id`/`keyframe_ids` from `[{shot_no, representative_ts_ms, keyframe_ts_ms[]}]`, counts, `status='frames_done'`, and appends the Modal cost to the ledger.
- `mkt_cv_search(p_qvec_image vector(768), p_qvec_text vector(1024), p_query_text text, p_filters jsonb, p_mode text ('shot'|'frame'), p_limit int)` → rows `(shot_id, video_id, frame_id, content_media_id, content_post_id, organization_id, org_name, platform, published_at, post_url, stored_url, start_ms, end_ms, duration_ms, representative_frame_url, summary, tags, score, why jsonb)`. RRF over three channels inside SQL; per-video/per-org caps and MMR in the API layer.
- `mkt_cv_search_frames(p_qvec_image, p_query_text, p_filters, p_limit)` → frame rows (representatives only) for `mode='frame'`.
- `mkt_cv_shot(p_shot_id uuid)` → jsonb (shot + frames + video + post + neighbours).
- Cost/budget: `mkt_cv_cost_add(kind, video_id, role, provider, model, cost)`, `mkt_cv_cost_today()`, `mkt_cv_budget_ok()`, `mkt_cv_enabled()`. Every paid call in the cv lanes MUST call `mkt_cv_cost_add`.
- `mkt_cv_health()` → jsonb `{videos:{by_status}, jobs:{by_kind_status}, oldest_running_s, cost_today_usd, cost_month_usd, budget_usd, paused}`.
- `mkt_cv_cost_today()` → numeric (sum of costs since midnight Riyadh).

## 2. Manifest contract (Modal → worker → `mkt_cv_ingest_manifest`)
```json
{ "video": { "duration_ms": 42500, "fps": 29.97, "width": 1080, "height": 1920,
             "detector_version": "psd-adaptive-1", "embedding_version": "siglip2-b16-256-1" },
  "shots": [ { "shot_no": 0, "start_ms": 0, "end_ms": 3200, "transition_in": "start", "transition_out": "cut",
               "is_static": false, "internal_change": false, "representative_ts_ms": 1500, "keyframe_ts_ms": [0, 1500] } ],
  "frames": [ { "ts_ms": 0, "shot_no": 0, "is_boundary": true, "phash": "a1b2…", "dup_group": 0,
                "storage_path": "content/frame/<video_id>/000000.webp", "public_url": "https://…/marketing-assets/content/frame/<video_id>/000000.webp",
                "width": 512, "height": 910, "bytes": 38211, "quality": { "blur": 0.12, "dark": 0.05 },
                "ocr": { "text": "…", "lang": "ar", "boxes": [], "inherited_from_ts_ms": null }, "labels": ["setting:exterior_facade","shot_size:wide"],
                "embedding": [ …768 floats… ] } ],
  "dup_groups": [ { "group": 0, "representative_ts_ms": 0, "size": 3 } ],
  "cost_usd": 0.01 }
```
Frames path: `content/frame/<video_id>/<ts_ms zero-padded 7>.webp` in bucket `marketing-assets` (public), webp q80, long side 512. Modal uploads directly (Modal secret `wassel-supabase` = `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).

## 3. Modal service `wassel-video-cv` (HTTP, token `MODAL_CV_TOKEN` header `x-wassel-token`)
- `POST /process {video_id, video_url, config:{frame_interval_ms:500, max_frames:2000, min_shot_ms:250, ocr:true, labels:true}}` → manifest (above). Idempotent per (video_url checksum, versions). Long videos may return `{"partial": true}` with the reason.
- `POST /embed_text {texts:[…]}` → `{model, version, dim:1024, vectors:[[…]]}` (bge-m3).
- `POST /embed_query {text}` → `{image_vec:[768], text_vec:[1024]}` (SigLIP-2 text tower + bge-m3).
- `POST /embed_images {urls:[…]}` → `{model, version, dim:768, vectors:[[…]]}` (SigLIP-2) — used for Wassel assets and on-demand.
- OCR: reuse the deployed Modal app `wassel-ocr` (`modal.Cls.from_name('wassel-ocr','OCR')().parse.map(png_bytes)`) from inside the service; if unavailable, fall back to PaddleOCR in-image and record `ocr_engine` in the manifest.
- Zero-shot labels: cosine of frame embedding vs. prompt embeddings of the controlled vocabulary (§6), top-k above threshold.

## 4. AI roles (worker `worker/src/ai/roles.ts`)
```ts
type RoleKey = 'script_writer'|'script_reviewer'|'claim_classifier'|'frame_describer'|'shot_analyzer'|'reference_explainer'|'embed_text'|'embed_image';
interface RoleConfig { provider:'anthropic'|'openai_compat'|'modal'; model:string; version?:string; params?:{max_tokens?:number; thinking?:'adaptive'|'off'; effort?:'low'|'medium'|'high'; temperature?:number} }
callRole<T>(role, {system, user, images?:{url|base64,mime}[], schema:JSONSchema, cache?:boolean}) → {output:T, usage:{in,out}, cost_usd, provider, model, version, latency_ms}
embed(role, input:{texts?:string[], image_urls?:string[]}) → {vectors:number[][], model, version, dim}
resolveRoles(sb) → Record<RoleKey, RoleConfig>  // mos_settings.ai_roles merged over code defaults; cached 60 s
```

**As implemented by W-AI (final):** `callRole<T>(role, req, ctx?)` where `req = {system, user, images?, schema, cache?}` and `ctx = {sb?, roles?, providers?}` — pass `{ sb }` (or pre-resolved `{ roles }`) from lanes so settings are honoured; `embed(role, input, ctx?)`; `embedQuery(text, ctx?) → {image_vec[768], text_vec[1024]}` (the /embed_query both-towers call used by search); `createRoleLedger()/recordRoleUse()/ledgerToJson()` accumulate `roles` jsonb + cost. Modal embedding cost is `null` (unknown ≠ free); Anthropic cost from `pricing.ts`, `null` for unpriced models. Errors carry the `provider:` prefix. Barrel: `worker/src/ai/index.ts`.

Defaults (non-final): writer `claude-opus-5`, reviewer `claude-sonnet-5`, classifier `claude-haiku-4-5-20251001`, frame_describer `claude-haiku-4-5-20251001`, shot_analyzer `claude-sonnet-5`, reference_explainer `claude-haiku-4-5-20251001`; embeddings Modal. Anthropic calls use `output_config.format` (structured outputs) with a tool-use fallback for models that reject it; adaptive thinking on; `cache_control` on the stable system prefix. Cost table in `worker/src/ai/pricing.ts` keyed by model id (unknown model → cost null, never a wrong number).

## 5. Script pipeline types (`worker/src/marketing/script/types.ts`)
```ts
interface Brief { content_id; project_id; project_ids:string[]; multi_project_warning:boolean; campaign?:{id,name,objective,kind,offer,audience_text,audience_id}; purpose:'organic'|'paid'|'both'|'unknown'; platforms:string[]; objective:string|null; audience:string|null; language:'ar'|'en'; cta:string; core_message?:string; idea?:string; hook?:string; recipe:string; duration_sec:number; scene_count_hint:number; funnel:'top'|'mid'|'bottom'; objection?:string; existing_scenes:{position,visual,voiceover,on_screen_text,footage_status}[]; assets_summary:{count:number; kinds:Record<string,number>}; }
type FactClass='price'|'area'|'unit_count'|'date'|'distance'|'duration'|'availability'|'guarantee'|'payment'|'unit_type'|'feature'|'landmark'|'status'|'name'|'location'|'other';
interface Fact { id:string /*F1*/; key:string; class:FactClass; value:unknown; rendered_ar:string; source_field:string; verified_at:string|null; claimable:boolean; note?:string }
interface FactsPackage { project_name:string; readiness:'off_plan'|'ready'|'unknown'|'conflict'; sold_out:boolean; facts:Fact[]; warnings:string[]; viable:boolean; missing:string[] }
interface Exemplar { id:string /*E1*/; content_post_id; organization_id; org_name; platform; content_type; language; views:number|null; similarity:number; transcript:string; ocr:string; campaign_message:string|null; selling_points:string[]; structure?:string[] }
interface DraftScene { order:number; purpose:'hook'|'location'|'product'|'feature'|'proof'|'offer'|'comparison'|'cta'|'brand'; duration_sec:number; start_sec:number; end_sec:number; voiceover:string; on_screen_text:string; visual:string; visual_intent:{shot_size:string; subject:string; setting:string; interior_exterior:'interior'|'exterior'|'graphic'|'mixed'; motion:string; graphic_kind:'none'|'text_overlay'|'animated_map'|'3d_render'|'motion_graphic'|'split_screen'; mood:string}; angle:string; fact_refs:string[]; learned_from:string[]; asset_requirement:'footage'|'image'|'graphic'|'animation'|'template'|'none'; production_note:string; warnings:string[] }
interface GenerationOutput { patterns_learned:{pattern:string; from:string[]}[]; scene_plan:{order:number; purpose:string; goal:string; facts:string[]}[]; scenes:DraftScene[]; hooks:string[] }
interface ClaimVerdict { scene:number; field:'voiceover'|'on_screen_text'; mention:string; class:string; verdict:'pass'|'fail'|'review'; fact_id?:string; reason:string }
interface ReviewReport { validator:{ claims:ClaimVerdict[]; entities:{scene,mention,kind}[]; checks:{key,level:'pass'|'warn'|'fail',detail}[] }; judge?:{ overall:'pass'|'revise'|'reject'; dialect:number; hook:number; progression:number; fit:number; completeness:number; notes:{scene:number,note:string}[] }; repaired:boolean; final:'ok'|'needs_attention' }
```

## 6. Controlled vocabulary (`worker/src/marketing/cv/vocab.ts` and Modal `labels.py` — keep identical)
`shot_size:{wide,medium,close,extreme_close,aerial}` · `setting:{exterior_facade,interior_living,kitchen,bedroom,bathroom,amenity_pool,gym,lobby,street,map,studio,render,office}` · `subject:{building,unit,person,presenter,family,vehicle,text_card,logo,map,plan}` · `graphic:{none,text_overlay,animated_map,3d_render,motion_graphic,split_screen,slideshow}` · `motion:{static,pan,tilt,dolly,drone,handheld,zoom}` · `light:{day,golden,night,studio}` · `purpose:{hook,location,product,feature,proof,offer,cta,brand}` · `reproducibility:{easy,moderate,hard}`.

## 7. Endpoint actions

### `api/marketing-os.ts` (caller JWT + `requireCap`; writes via service client)
- `script_recipes` → `{recipes:[{key,label_ar,label_en,default_duration_sec,scene_count_hint,version}]}`.
- `script_brief {content_id}` → `{brief:Brief, recommended_recipe:string, warnings:string[]}` (server builds the brief from content/campaign/audience/project/scenes/assets; the same builder module is duplicated in the worker — keep both in sync per repo copy-rule, or expose via RPC; **decision: implement `buildBrief` once in SQL as `mos_script_brief(p_content_id)` returning jsonb so both API and worker call it**).
- `write_video_script {content_id, recipe, duration_sec?, audience?, objection?, regenerate?}` → `{job}`; refuses (409) while an unapplied draft exists unless `regenerate`, which discards it. Validates `recipe` against `mos_script_recipes`.
- `script_job_status {content_id}` → `{job:{id,status,stage,recipe,error,draft_id,created_at,finished_at}}`.
- `script_draft_get {draft_id|content_id}` → `{draft}` (full row; scenes, hooks, review, facts).
- `script_draft_preview_apply {draft_id, mode:'append'|'replace'}` → `{replaceable:[{id,position,visual}], protected:[{id,position,reason:'edited'|'shoot_linked'|'production_used'|'manual'}], will_insert:number}`.
- `script_draft_apply {draft_id, mode, chosen_hook?:number, confirm_remove_ids?:string[]}` → `{scenes, removed:string[], draft}` — server recomputes protection; refuses if `confirm_remove_ids` ≠ current replaceable set.
- `script_draft_discard {draft_id}`; `script_draft_feedback {draft_id, rating, note}`.
- `scene_save` (existing) additionally stamps `manually_edited_at=now(), last_edited_by` on any human change.
- `scene_references_suggest {scene_id | draft_id+scene_index, k?}` → `{competitor:[…], wassel_assets:[…], gap}` (Phase 4; returns `{unavailable:true}` cleanly when the visual system is off).
- `scene_reference_set {reference_id, status}`.
- Remove: `video_script_apply`.

### `api/marketing.ts` (competitor intelligence; gate `wassell_mkt_can`)
- `cv_health`, `cv_video {content_media_id|video_id}`, `cv_shot {shot_id}`, `cv_frame {frame_id}` (triggers on-demand describe when `analysis` is null and the frame is materially different), `cv_search {q, filters, mode, limit}` (applies diversity: ≤1 shot/video unless `per_video`, ≤3/org, collapse duplicate videos, MMR λ 0.7), `cv_enqueue {content_media_id}` (admin), `cv_backfill_status`.

## 8. Client types
- `src/lib/marketingOS/client.ts`: `ScriptRecipe`, `ScriptBrief`, `ScriptJobRow (+stage, draft_id)`, `ScriptDraft`, `DraftScene`, `ReviewReport`, `ApplyPreview`, wrappers for every action above; `MosScene` gains `source, source_draft_id, manually_edited_at, purpose, visual_intent, fact_refs`.
- `src/lib/competitorWatch/client.ts`: `CvHealth`, `CvVideo`, `CvShot`, `CvFrame`, `CvSearchResult`, wrappers.

## 9. Job kinds and lanes
- Script: `mos_script_jobs` (existing lane). Stages written via `mos_script_job_stage`: `brief → facts → retrieve → write → validate → review → repair → draft`.
- Visual: `mkt_cv_jobs` — worker lanes `cvProcessPollLoop` (kind `cv_process`, `cv_embed_wassel`) and `cvAnalyzePollLoop` (kinds `cv_analyze`, `cv_describe_frame`). Both gated by `mkt_settings.cv.enabled`; budget check before each LLM call (`mkt_cv_cost_today() < cv.daily_budget_usd` else fail job with `budget_exceeded` and `mkt_alert_emit`).

## 10. File ownership (one owner per file; others propose edits to the owner via the coordinator)

| Owner | Files |
|---|---|
| **W-AI** (roles + providers) | `worker/src/ai/**` |
| **W-SCRIPT** | `worker/src/marketing/script/**`, `worker/src/runScriptJob.ts`, delete `worker/src/marketing/videoScript.ts` |
| **W-CV** | `worker/src/marketing/cv/**`, the cv lanes in `worker/src/index.ts` (only the marked region), `worker/src/marketing/content/runContentProcess.ts` (enqueue hook + MAX_IMAGES chunking), `worker/src/marketing/content/sweepBacklog.ts` (stage 5), `worker/src/env.ts` (new keys) |
| **MODAL** | `infra/modal/video-cv/**`, Modal deploy + secrets |
| **API** | `api/marketing-os.ts` (script + reference actions), `api/marketing.ts` (cv actions), delete `api/_lib/marketing/videoScript.ts` |
| **UI-MOS** | `src/lib/marketingOS/client.ts`, `src/pages/Marketing/components/{ScriptBriefModal,ScriptDraftReview,SceneReferences}.tsx`, `src/pages/Marketing/ContentDetailPage.tsx`, `src/pages/Marketing/components/SceneTable.tsx`, delete `VideoScriptModal.tsx` |
| **UI-CW** | `src/lib/competitorWatch/client.ts`, `src/pages/CompetitorWatch/**` (Visual library surface + nav) |
| **ASR** | `worker/src/marketing/content/falTranscribe.ts`, `scripts/retranscribe-arabic.mjs`, `docs/eval/asr-ab/**` |
| **EVAL** | `scripts/eval/**`, `docs/eval/**` (except asr-ab), worker tests for script modules are owned by W-SCRIPT; EVAL owns the golden sets and harness |
| **DOCS** (final wave) | `.claude/skills/writing-video-script/SKILL.md`, `docs/prd/marketing-workspace.md`, `docs/prd/competitor-watch.md`, `worker/README.md`, `CLAUDE.md` section |
| **COORD** | migrations, this document, `worker/src/index.ts` script-lane edits, deploys, backfills, final verification |

## 11. Integration order
1. Migrations (done) → contracts (this) → agents start in parallel: W-AI, W-SCRIPT, W-CV, MODAL, API, UI-MOS, UI-CW, ASR, EVAL.
2. Gate A (ASR A/B) → transcription backfill (COORD).
3. Typecheck all three packages + vitest → worker deploy + app deploy behind flags (`script_writer_v2`, `cv.enabled=false`).
4. Gate B (30-video shot detection + ingest on prod with `cv.enabled` limited to the golden set) → analysis on the 30 → search eval (Gate C) → full backfill (COORD).
5. Phase-4 integration agent (references, Wassel assets, gaps) after UI-MOS + W-CV land.
6. DOCS wave; remove legacy paths; final live smoke.

## 12. Conventions
- Worker tests: vitest, `__tests__/*.test.ts`, pure modules testable without network (inject `sb`/`callRole`).
- Costs: every LLM/embedding call returns `cost_usd` (null if unknown model) and is summed onto the job/draft/video row.
- Errors: throw with a stable `kind` prefix (`facts_insufficient:`, `provider:`, `budget_exceeded:`, `validation_unrepaired:`) — lanes map prefixes to job `error_kind`.
- Timestamps: ms integers in DB and JSON; seconds only in `mos_scenes.start_sec/end_sec`.
- Arabic normalisation: `mkt_norm_ar(text)` in SQL; the TS twin lives in `worker/src/marketing/script/entities.ts` (`normAr`) and must match (folds أإآ→ا, ة→ه, ى→ي, strips tatweel/diacritics, unifies digits).
