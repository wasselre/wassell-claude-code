# Post Creative Director — Shared Contracts

*Authoritative for every agent on this build. Do not deviate; propose changes to the lead. 2026-09-02.*

Sibling contract (in flight, same day, worktree `elegant-albattani-c38c42`, migrations `2026-09-02_10…_16` ALREADY APPLIED to prod): `docs/marketing-script-visual-contracts.md` — Script Writer v2 + video visual intelligence. **We build ON it, never beside it.** Concretely we REUSE, by verbatim copy at the same paths (so merges auto-resolve):

- `worker/src/ai/**` — the provider-independent AI-role adapter (`callRole`, `embed`, `embedQuery`, ledgers, pricing). Roles are DATA in `mos_settings.ai_roles`.
- `worker/src/marketing/script/{types,facts,entities,claims,brief}.ts` — facts package (`buildFactsPackage` → `Fact{id:'F1', class, rendered_ar, source_field, claimable}`), Arabic normalisation (`normAr`), claim extraction/gating (`extractMentions`, `classifyMention`, `gateByClass`, `verifyClaims`), entity blocklist (`buildBlocklist`, `detectEntities`).
- `scripts/eval/_lib/env.mjs` + `scripts/_lib/serviceClient.mjs` — eval harness plumbing.
- DB: `mos_script_brief(p_content_id)` (campaign/audience/platforms/language brief), `mkt_content_embeddings`, `vector` extension, `mos_settings.ai_roles` row shape `{ role: {provider, model, version?, params?} }`.

**Never edit those copied files.** If you need a change, tell the lead (it must go to the other lead too).

## 0. Non-negotiables (approved plan + operator corrections)

1. Additive only. No DROP/RENAME/route removal. `mos_script_jobs`, `/marketing/posts`, `mkt_*` v2 schema untouched. Competitor media stays PUBLIC (`marketing-assets`, permanent `stored_url`); no signed URLs for it.
2. No vendor lock-in in code: every model call is a ROLE resolved from `mos_settings.ai_roles`; image roles use the image provider registry (`worker/src/creative/imageProvider.ts`). Temporary configured defaults are allowed; architecture must not depend on them.
3. Facts: numbers allowed anywhere (headlines, design text, captions, ad copy) **only** when they cite a `Fact.id` with `claimable=true`; every number carries `fact_refs`. Off-plan/ready from `FactsPackage.readiness` only. Developer MAY be named (`allow_developer_name`); marketers/competitors/phones/licences/handles never.
4. Project name is `design_text.project_name_lead`; it need not repeat in headline lines.
5. Language = `mos_content.language`; no automatic second language. Bilingual project names allowed in `latin_name`.
6. Base creative ≠ derivatives. `intended_use` is authored on the package, never derived from placement rows. Organic copy only for selected organic targets; paid copy only for selected paid usages. Manually-published platforms (X, website) still get derivatives when selected.
7. Dimensions come from `PLACEMENT_SPECS` per selected target; never hardcode 4:5. Each derivative carries a full `VisualAdaptation` (crop/extend, text/logo reposition, layout changes, scaling, slide mapping, asset substitutions, `requires_separate_design`).
8. AI image work = recommendation in the package; execution ONLY after a human approval (`creative_ai_approve` → `generation_jobs kind='creative-image'`), and only when `creative_writer.ai_image_execution` is on. Outputs are candidates (`files.usage_rights='needs_review'`, `asset_nature ai_edited|ai_generated`, `mos_asset_links role='reference'`) until a human promotes them. Fabrication policy (§7) enforced in prompt builder AND validator.
9. Rights: competitor media is reference-only; `restricted`/`do_not_use` never selectable for production; Wassel-owned per its rights; developer-supplied presented as production candidates with source + verification visible; unclear/AI-suggested rights → `needs_rights_confirmation=true` (human confirms before final approval — `content_set_approval_asset` re-checks); AI outputs require review; rights re-checked at final approval.
10. Writer applies during the writing step; existing `writing_review` is the approval; no new approval stage. Apply is auditable (`applied_snapshot`) and reversible (`creative_package_revert`). Never overwrite non-empty captions/ad copy/assets/human edits without an explicit `overwrite` flag per field.
11. Wassel registered as `mkt_organizations(org_type='internal')` with the existing handles; internal posts EXCLUDED from competitor shelves/retrieval unless `p_include_wassel`.
12. Brand kit is DATA with `status draft|reviewed`; `mode='advisory'` until reviewed (deviations listed, not failed), `constraint` after (validator enforces). Reviewers: `approve_creative` capability (Rayyan / marketing manager) — never the writer alone.
13. Role map: `mos_settings.role_map.design_owner` (default `montage`); code never hardcodes `montage`.
14. Feature flags in `mos_settings.creative_writer`; every lane checks its flag each tick; rollback = flip.
15. No silent catches. Loud errors with stable prefixes (`provider:`, `facts_insufficient:`, `validation_unrepaired:`, `rights_blocked:`, `policy_blocked:`, `budget_exceeded:`). Every job/row records model, roles ledger, cost.
16. Bilingual UI (`isAr ? … : …`), RTL-first. No `any`. Existing RLS posture: new tables have RLS enabled, NO policies; browser reads/writes go through the API with `requireCap` + service client.

## 1. Feature flags & settings rows (`mos_settings`, key → jsonb)

| key | shape | default |
|---|---|---|
| `creative_writer` | `{post_enabled, ai_image_execution, design_reads_enabled, asset_enrich_v2, backfill_enabled}` | all `false` |
| `brand_kit` | `BrandKit` (contracts.ts) | drafted, `status:'draft'`, `mode:'advisory'` |
| `writer_rules` | `WriterRules` | seeded from both skills' Decisions Logs |
| `role_map` | `RoleMap` | `{design_owner:'montage', design_reviewer:'marketing_manager'}` |
| `ai_roles` | existing row — we ADD keys via `value = value || '{…}'` (never replace): `creative_concepts`, `creative_package`, `creative_derivatives`, `design_read_slide`, `design_read_post`, `asset_enrich_v2`, `image_edit`, `image_generate`, `image_remove_text` | see §5 |
| `creative_backfill` | `{ design_reads: {enabled, tiers:[…], batch_size, lane:'runner'|'worker'}, asset_meta: {…}, asset_enrich: {…} }` | disabled |

## 2. Schema (migrations `supabase/migrations/2026-09-02_2N_creative_*.sql`; owner A-DB except `_26` A-BRAND)

All tables: `RLS ENABLE`, no policies. All RPCs `SECURITY DEFINER SET search_path='public'`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO service_role` (reads also `authenticated` where the SPA calls them through the API only → still service_role only; keep it strict).

### `_20_creative_jobs.sql`
```sql
CREATE TABLE public.mos_creative_jobs (
  id uuid PK DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES public.mos_content(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('post_concepts','post_package','post_regenerate','post_derivatives')),
  params jsonb NOT NULL DEFAULT '{}',           -- {recipe?, concept_id?, package_id?, targets:[DerivativeTarget], revision_note?, overrides?}
  requested_by uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  stage text, worker_id text, attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 2,
  result jsonb, error text, error_kind text, roles jsonb, cost_usd numeric,
  created_at timestamptz DEFAULT now(), started_at timestamptz, finished_at timestamptz, lease_expires_at timestamptz
);
CREATE UNIQUE INDEX mos_creative_jobs_one_active ON public.mos_creative_jobs(content_id) WHERE status IN ('queued','running');
CREATE INDEX mos_creative_jobs_claim ON public.mos_creative_jobs(created_at) WHERE status='queued';
-- RPCs: mos_creative_job_enqueue(p_content_id, p_kind, p_params, p_requested_by) → uuid (raises 'active_job_exists' on the unique index)
--       mos_creative_job_claim_next(p_worker_id) → (job_id, content_id, kind, params, requested_by, attempts)  FOR UPDATE SKIP LOCKED
--       mos_creative_job_stage(p_job_id, p_stage), mos_creative_job_complete(p_job_id, p_result, p_roles, p_cost_usd),
--       mos_creative_job_fail(p_job_id, p_error, p_error_kind)  -- requeue while attempts < max_attempts AND error_kind IN ('provider','transient'); else failed
--       mos_creative_job_cancel(p_job_id), mos_creative_jobs_watchdog() → int (running > 10 min → fail 'watchdog')
```

### `_21_creative_packages.sql`
```sql
CREATE TABLE public.mos_creative_packages (
  id uuid PK, content_id uuid NOT NULL REFERENCES mos_content(id) ON DELETE CASCADE,
  round int NOT NULL, version int NOT NULL,
  stage text NOT NULL CHECK (stage IN ('concepts','package')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','applied','superseded','rejected')),
  intended_use text NOT NULL DEFAULT 'organic' CHECK (intended_use IN ('organic','paid','both')),
  language text NOT NULL, recipe text, concept_id text,
  concepts jsonb, base jsonb, facts jsonb, facts_used jsonb NOT NULL DEFAULT '[]',
  brand_kit_version int, brand_kit_mode text CHECK (brand_kit_mode IN ('advisory','constraint')),
  roles jsonb, cost_usd numeric, generated_by text NOT NULL DEFAULT 'ai' CHECK (generated_by IN ('ai','human')),
  job_id uuid REFERENCES mos_creative_jobs(id) ON DELETE SET NULL,
  created_by_user_id uuid, applied_at timestamptz, applied_by_user_id uuid, applied_snapshot jsonb,
  revision_note text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  UNIQUE (content_id, version)
);
CREATE INDEX ON mos_creative_packages(content_id, created_at DESC);
CREATE TABLE public.mos_creative_derivatives (
  id uuid PK, package_id uuid NOT NULL REFERENCES mos_creative_packages(id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('organic','paid')), platform text NOT NULL, placement_type text NOT NULL,
  target_ref jsonb NOT NULL DEFAULT '{}', dimensions jsonb NOT NULL, adaptation jsonb NOT NULL, copy jsonb NOT NULL,
  limits jsonb NOT NULL DEFAULT '{}', warnings jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','applied','superseded')), applied_at timestamptz, created_at timestamptz DEFAULT now(),
  UNIQUE (package_id, target_kind, platform, placement_type)
);
CREATE TABLE public.mos_creative_refs (
  id uuid PK, package_id uuid NOT NULL REFERENCES mos_creative_packages(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('reference','selected_asset')),
  ref_kind text NOT NULL CHECK (ref_kind IN ('competitor_post','competitor_media','wassel_content','wassel_file','file')),
  ref_id uuid NOT NULL, slide_index int, level text CHECK (level IN ('slide','post')),
  aspect text, usage text, rights_snapshot jsonb, rationale jsonb NOT NULL DEFAULT '{}', created_at timestamptz DEFAULT now()
);
-- RPC: mos_creative_package_next_version(p_content_id) → int; mos_creative_package_patch(p_package_id uuid, p_path text[], p_value jsonb) → void
--      (single-row jsonb_set on `base`, used by the image lane to write ai_recommendations[i].execution — never read-modify-write from JS)
```

### `_22_visual_design_reads.sql`
```sql
CREATE TABLE public.visual_design_reads (
  id uuid PK, subject_kind text NOT NULL CHECK (subject_kind IN ('competitor_media','competitor_post','wassel_file','wassel_content')),
  subject_id uuid NOT NULL, level text NOT NULL CHECK (level IN ('slide','post')),
  post_id uuid, slide_index int, organization_id uuid,
  model_task text NOT NULL, model_used text NOT NULL, rule_version text NOT NULL,
  read jsonb NOT NULL, confidence numeric, cost_usd numeric, raw jsonb,
  embedding vector(768),                        -- SigLIP-2 image embedding of the slide (nullable; via embed('embed_image'))
  status text NOT NULL DEFAULT 'done' CHECK (status IN ('done','failed')), failure_reason text,
  created_at timestamptz DEFAULT now(),
  UNIQUE (subject_kind, subject_id, level, model_used, rule_version)
);
-- generated columns for ranking: layout_family text, density text, branding_intensity int, palette_family text, format text, slide_role text
CREATE INDEX ON visual_design_reads(subject_kind, level, post_id);
CREATE INDEX ON visual_design_reads USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;
-- RPC: visual_design_read_upsert(p_subject_kind, p_subject_id, p_level, p_post_id, p_slide_index, p_organization_id, p_model_task, p_model_used, p_rule_version, p_read, p_confidence, p_cost_usd, p_raw, p_status, p_failure, p_embedding) → uuid
--      creative_design_read_targets(p_subject_kind, p_level, p_rule_version, p_model_used, p_tier int, p_limit int) → subjects lacking a read (tiering in §9)
--      mkt_creative_references(p_project_id uuid, p_district text, p_unit_types text[], p_purpose text[], p_intent jsonb, p_include_wassel bool, p_qvec vector(768), p_limit int)
--        → (ref_kind, ref_id, post_id, slide_index, level, preview_url, org_name, platform, published_at, post_url, score, why jsonb, read jsonb)
--        ranking: purpose match, district/unit match, recency, non-general-branding, org diversity; + design-read intent similarity when reads exist; + vector cosine when p_qvec not null; engagement tie-breaker; internal org excluded unless p_include_wassel; approved examples boosted.
```

### `_23_design_examples_wassel_org.sql`
```sql
CREATE TABLE public.mos_design_examples (
  id uuid PK, subject_kind text NOT NULL CHECK (subject_kind IN ('wassel_content','wassel_file','competitor_post')),
  subject_id uuid NOT NULL, example_kind text NOT NULL CHECK (example_kind IN ('approved_wassel','study_only')),
  strengths text[] NOT NULL DEFAULT '{}', caveats text[] NOT NULL DEFAULT '{}', note text,
  approved_by_user_id uuid NOT NULL, approved_at timestamptz DEFAULT now(), retired_at timestamptz,
  UNIQUE (subject_kind, subject_id)
);
-- CHECK: competitor_post only with example_kind='study_only'
-- DATA: INSERT Wassel into mkt_organizations (org_type='internal', name_ar 'وصل العقارية', name_en 'Wassel Real Estate', website 'https://wassel.re')
--       + mkt_social_accounts rows from mos_platform_accounts handles (instagram wassel.re, tiktok wasselre, snapchat wasselre, x @wassel_sa) — idempotent, ON CONFLICT DO NOTHING. Inspect mkt_social_accounts columns first (platform, handle, external_id?, is_active, collection flags).
-- mkt_content_library v5: media ORDER BY carousel_index; EXCLUDE org_type='internal' rows from competitor shelves.
```

### `_24_files_signals_rights.sql`
```sql
ALTER TABLE public.files ADD COLUMN IF NOT EXISTS dominant_colors jsonb, ADD COLUMN IF NOT EXISTS has_text boolean,
  ADD COLUMN IF NOT EXISTS headline_space text CHECK (headline_space IN ('none','top','bottom','left','right','center')),
  ADD COLUMN IF NOT EXISTS ocr_text text, ADD COLUMN IF NOT EXISTS visual_meta_version text;
CREATE VIEW public.files_rights_v AS … (rights_provenance, rights_verified per latest file_metadata_provenance row for usage_rights);
-- RPC: creative_candidate_assets(p_project_id uuid, p_limit int) → files of the project (file_links model all_projects) with kind='image',
--      columns: file_id, original_name, primary_category, document_type, link_role, asset_nature, acquisition_source, usage_rights, rights_provenance, rights_verified,
--      production_state, aspect_ratio, width_px, height_px, ai_description, tags, subjects, dominant_colors, has_text, headline_space, storage_bucket, storage_path
--      ORDER: rights_verified & usage_rights in (approved,use_after_edit) → developer/internal source → production_state raw → real/cgi → recency. EXCLUDES restricted/do_not_use.
--      creative_asset_backfill_targets(p_kind text ('meta'|'enrich'), p_limit int) → files lacking dims/colours (meta) or v2 enrichment (enrich), project-linked first.
```

### `_25_performance_flags_jobs.sql`
```sql
CREATE VIEW public.mos_content_performance_v AS … (per content: publications, latest snapshot sums views/engagement/likes/comments/saves/enquiries, last_captured_at);
-- generation_jobs kind CHECK: re-list ('image','video','audio','clean-text','video-convert','listing-mirror','creative-image')  ← read the LIVE constraint first and re-list EVERY value
-- claude_jobs kind CHECK: re-list all 7 existing + 'mkt_visual_design_slide','mkt_visual_design_post'
-- mos_settings seeds: creative_writer, writer_rules, role_map, creative_backfill; ai_roles ADDITIVE merge (value = value || new keys, only keys not present)
-- creative_backfill_runs(id, kind text, tier int, status, started_at, finished_at, processed int, failed int, cost_usd numeric, worker_id, note) + creative_backfill_run_touch RPCs
-- notification rules seed: event 'post_creative_ready' (in-app) for the requester (copy the video_script_ready seed pattern; find it in the live notification_rules first)
```

### `_26_brand_kit_seed.sql` (A-BRAND)
Seeds `mos_settings.brand_kit` (the drafted kit) ON CONFLICT DO NOTHING, and `writer_rules` content if A-DB left placeholders (coordinate: A-DB seeds `writer_rules` from the skills; A-BRAND seeds `brand_kit` only).

### `_27_creative_rpcs_extra.sql` (A-DB, after others land) — anything agents requested via the lead.

## 3. Job kinds & lanes

| Queue | kind | Lane file | Owner |
|---|---|---|---|
| `mos_creative_jobs` | post_concepts / post_package / post_regenerate / post_derivatives | `worker/src/creative/lanes/creativeJobsLane.ts` → `runCreativeJob.ts` | A-WORKER |
| `generation_jobs` | `creative-image` | `worker/src/creative/lanes/creativeImageLane.ts` → `runCreativeImageJob.ts` | A-WORKER |
| `claude_jobs` | `mkt_visual_design_slide`, `mkt_visual_design_post` | `scripts/claude-study-runner.mjs` handlers | A-VIS |
| worker sweep (no queue) | design reads via API roles + backfill controller | `worker/src/creative/lanes/designReadLane.ts` | A-VIS |
| worker sweep | asset deterministic meta + v2 enrichment backfill | `worker/src/creative/lanes/assetMetaLane.ts` | A-ASSETS |

Lane contract (`worker/src/creative/lanes/types.ts`, owner A-WORKER, written FIRST):
```ts
export interface LaneDeps { supabase: SupabaseClient; env: WorkerEnv; workerId: string; sleep(ms:number):Promise<void>; isShuttingDown():boolean; log(msg:string, extra?:unknown):void }
export type LaneLoop = (deps: LaneDeps) => Promise<void>;   // each lane exports `export const <name>Loop: LaneLoop`
```
`worker/src/index.ts` (A-WORKER only) imports the four loops and pushes them into `Promise.all` guarded by env presence; each loop reads its flag from `mos_settings.creative_writer` every tick and sleeps 30 s when off.

## 4. Endpoint actions

### `api/marketing-os.ts` (A-API) — dispatch only; handlers in `api/_lib/marketing/creative/*.ts`
| action | gate | payload → result |
|---|---|---|
| `creative_flags` | read | → `{flags: CreativeFlags, role_map, brand_kit_status}` |
| `creative_targets` | read | `{content_id}` → `{organic:[{platform, placement_type, publication_id?, selected}], paid:[{platform, placement_type, execution_id, ad_set_id?, ad_id?, selected}], suggested_master_aspect}` |
| `write_post_creative` | write_content | `{content_id, targets:DerivativeTarget[], recipe?, intended_use}` → `{job:CreativeJobRow}` (kind post_concepts; 409 while an active job; requires project) |
| `creative_concept_select` | write_content | `{package_id (concepts), concept_id | custom:{title,angle,format}}` → `{job}` (kind post_package) |
| `creative_regenerate` | write_content | `{package_id, revision_note}` → `{job}` (kind post_regenerate → new version, old superseded) |
| `creative_job_status` | read | `{content_id}` → `{job|null}` |
| `creative_package_list` | read | `{content_id}` → `{packages: CreativePackageRow[]}` |
| `creative_package_get` | view_content_body | `{package_id}` → `{package, derivatives, refs, previews:{[ref_id]: url}}` |
| `creative_package_save` | write_content | `{package_id, base?, derivatives?}` → new version generated_by='human' |
| `creative_asset_replace` | write_content | `{package_id, asset_index, file_id}` → package (re-snapshots rights) |
| `creative_package_apply` | write_content | `{package_id, overwrite:{headlines?,design_brief?,captions?,ad_copy?}, confirm_unverified_rights?:boolean}` → `{applied, package}` writes: data.headlines (+slide-prefixed for carousel), data.design_brief (rendered), data.hashtags, data.design_reference_file_ids (our files only), captions via the SAME code path as `content_caption_save` (organic derivatives), ad creative via `content_ad_creative_save` path (paid derivatives with target_ref), `asset_link_from_file` role source for is_production assets; `applied_snapshot` = prior values of every touched field |
| `creative_package_revert` | write_content | `{package_id}` → restores `applied_snapshot` fields; package status→'superseded' |
| `creative_ai_approve` | write_content (+ flag ai_image_execution) | `{package_id, index}` → `{job_id}` enqueues generation_jobs creative-image; refuses policy violations |
| `creative_ai_dismiss` | write_content | `{package_id, index}` |
| `creative_handoff` | read | `{content_id}` → `DesignerHandoff` (from the latest applied package) |
| `creative_performance` | read | `{content_id}` → `mos_content_performance_v` row + applied package summary |
| `brand_kit_get` / `brand_kit_save` / `brand_kit_review` | read / manage_settings / approve_creative | review sets `status='reviewed', mode='constraint', reviewed_by/at`, bumps `version` |
| `writer_rules_get` / `writer_rules_save` | read / manage_settings | |
| `role_map_get` / `role_map_save` | read / manage_settings | |
| `creative_flags_save` | manage_settings | |
| `ai_roles_get` / `ai_roles_save` | manage_settings | (admin view of `mos_settings.ai_roles`; validate shape; never removes keys) |
| `design_example_set` | approve_creative | `{subject_kind, subject_id, example_kind, strengths[], caveats[], note, retire?}` |
| `design_example_list` | read | → examples with previews |

### `api/marketing.ts` (A-API) — gate `wassell_mkt_can` like siblings
`design_read_get {subject_kind, subject_id}`, `design_reads_status`, `creative_backfill_status`, `creative_backfill_control {kind, action:'start'|'pause'|'resume', tier?}` (admin), `wassel_internal_status` (is Wassel registered, accounts, collected counts).

### Client
`src/lib/marketingOS/creativeClient.ts` (A-API) — one wrapper per action; needs `call`/`authHeader` exported from `client.ts` as `export { call as mosCall }` (A-API adds that ONE line).

## 5. AI roles (data) — additive keys in `mos_settings.ai_roles`
```
creative_concepts    {provider:'anthropic', model:'claude-sonnet-5', params:{max_tokens:2500, thinking:'adaptive', effort:'medium'}}
creative_package     {provider:'anthropic', model:'claude-opus-5',   params:{max_tokens:8000, thinking:'adaptive', effort:'high'}}
creative_derivatives {provider:'anthropic', model:'claude-sonnet-5', params:{max_tokens:5000, thinking:'adaptive', effort:'medium'}}
design_read_slide    {provider:'anthropic', model:'claude-sonnet-5', params:{max_tokens:2000}}   -- or provider:'runner' (see below)
design_read_post     {provider:'anthropic', model:'claude-sonnet-5', params:{max_tokens:3000, thinking:'adaptive', effort:'medium'}}
asset_enrich_v2      {provider:'anthropic', model:'claude-haiku-4-5-20251001', params:{max_tokens:1500}}
image_edit           {provider:'fal', model:'fal-ai/nano-banana-pro/edit'}
image_generate       {provider:'fal', model:'fal-ai/nano-banana-pro'}
image_remove_text    {provider:'fal', model:'fal-ai/flux-2/klein/4b/edit'}
```
`worker/src/creative/roles.ts` (A-AI): `CREATIVE_ROLE_KEYS`, `CREATIVE_DEFAULTS`, `resolveCreativeRoles(sb)` (reads the same row; my keys only; the sibling adapter warns on unknown keys — acceptable), `callCreativeRole<T>(key, req, ctx)` = `callRole(cfg /*explicit RoleConfig*/, req, ctx)`. Provider `'runner'` for design reads = write a `claude_jobs` row and resolve on completion (A-VIS implements the runner side; A-AI implements the provider that enqueues+polls with a timeout). Image provider registry: `worker/src/creative/imageProvider.ts` — `ImageProvider { kind:'fal'|'stub'; generate(); edit(); removeText() }` wrapping `worker/src/imageGen.ts`; config from `ai_roles.image_*`.

## 6. Retrieval + ranking (A-DB SQL, consumed by A-WORKER)
- `mkt_creative_references` (§2) — competitor + Wassel (approved examples) with previews; slide order from `mkt_content_media.carousel_index`.
- `creative_candidate_assets` — project images ranked, with rights trust.
- Intent vector: worker calls `embed('embed_image', {image_urls:[…]})` on the top candidate asset(s) when `MODAL_CV_URL` is set; else `p_qvec=null`.

## 7. Image policy (enforced in `worker/src/creative/director/policy.ts`, A-GEN)
ALLOWED modes: cleanup, crop, color_correct, extend_background, remove_clutter, combine (approved assets), supporting_visual (lifestyle/abstract, no project features), remove_text, request_photo.
FORBIDDEN: any prompt that creates/changes the project's building, units, interiors, views, amenities, architectural features, or characteristics absent from the facts. Detector: prompt must not contain build/add/create verbs targeting those nouns (AR+EN lists) unless mode ∈ {cleanup, crop, color_correct} and must_keep includes 'architecture'. Violations → `policy_blocked:` and the recommendation is emitted with `status:'dismissed'` + warning, never queued.

## 8. Validators (A-FACTS `worker/src/creative/grounding.ts`; pure, unit-tested)
- `validateConcepts`, `validateBase`, `validateDerivatives` → `{ok, errors:[{path, rule, detail}], warnings}`.
- Rules: project_name_lead non-empty and equals facts.project_name (or its known Latin); headlines 1–4 (single) / cover 1–3 + per-slide 1; every mention (via `extractMentions`) in headlines/slides/captions/ad copy resolved by `gateByClass` against `claimable` facts with a `fact_refs` entry; readiness wording matches `readiness`; entity gate (`detectEntities` blocklist: marketer, competitors, phones, handles, licences) — developer allowed; captions only for selected organic targets, ≤ `caption_max`, hashtags ≤ `hashtags_max`, no competitor hashtags; paid copy only for selected paid targets; assets: no competitor refs in `assets`, no restricted/do_not_use, `needs_rights_confirmation` set when `!rights_verified`; palette ⊂ brand kit or listed in `deviations` (advisory) / error (constraint); language equals record; prohibited phrases from `writer_rules` (e.g. «بدون سعي»); AI recommendations pass §7.
- Retry-with-violation: the orchestrator re-prompts once with the error list; unresolved → package saved with `warnings` + `status draft` and job result `{needs_attention:true}` (never silently dropped).

## 9. Backfill controller (A-VIS design reads, A-ASSETS asset meta) — shared shape `worker/src/creative/backfill.ts` (A-VIS writes; A-ASSETS reuses)
- Config `mos_settings.creative_backfill.<kind>`: `{enabled, lane, batch_size, tiers:[1,2,3], paused_at}`; `creative_backfill_runs` rows for observability.
- Tiers for design reads (competitor statics): 0 pilot list (docs/eval/creative-design-read-pilot.json) → 1 project-attributed & !general_branding → 2 !general_branding last 12 months → 3 carousels → 4 rest; Wassel internal org: all. Asset meta: deterministic first (all project-linked images), then enrich v2 by active-campaign projects → verified-rights → rest.
- Idempotent (unique key on reads), resumable (targets RPC selects missing for current model+rule_version), interruptible (flag each batch), versioned (rule_version constant per module, model_used from the role), duplicate-safe (claim via `FOR UPDATE SKIP LOCKED` on `creative_backfill_claims`? — no: use the targets RPC + upsert; two workers may double-process at most one batch; acceptable, recorded).
- Cost gate: API lanes refuse to run a tier unless `creative_backfill.<kind>.approved_cost_usd` ≥ estimate (pilot measures per-item cost); runner lane has no incremental cost.

## 10. Placement specs (`src/lib/marketingOS/platformRules.ts`, A-FACTS; copy → `worker/src/creative/placementSpecs.ts`)
`PLACEMENT_SPECS: PlacementSpec[]` for instagram feed/carousel/story, tiktok photo_mode, snapchat story, x post, meta ad_feed/ad_story/ad_carousel/ad_reels, google ad_display, website post (manual). `masterAspectFor(targets)`, `adaptationSkeleton(master, target)` (deterministic geometry: crop vs extend vs separate design when aspect families differ, safe zones) — the model fills the instructions, the skeleton fixes the facts.

## 11. UI (A-UI) — files
`src/pages/Marketing/components/creative/{CreativeTab,TargetsPicker,ConceptCards,BaseCreativeEditor,SlideNavigator,DerivativesPanel,ReferencesPanel,AssetsPanel,AiRecommendationsPanel,PalettePanel,WarningsPanel,HandoffView}.tsx`, `src/pages/Marketing/components/{SettingsBrandKit,SettingsWriterRules,SettingsAiRoles}.tsx`; edits: `ContentDetailPage.tsx` (button + `creative` tab + handoff for design owner via role_map), `MarketingWorkspace.tsx` (settings nav), `src/App.tsx` (settings routes), `src/lib/i18n.ts` if used. Competitor Watch: `src/pages/CompetitorWatch/components/ContentLibrary.tsx` chip + "study example" action; `src/lib/competitorWatch/client.ts` wrappers (A-API writes wrappers there too — coordinate: A-API owns both client files).

## 12. File ownership (one owner per file)
| Owner | Files |
|---|---|
| LEAD | `src/lib/creative/contracts.ts` + worker copy, this doc, final integration, merges, deploys, backfill runs |
| A-DB | `supabase/migrations/2026-09-02_2{0,1,2,3,4,5,7}_creative_*.sql`, applies them, `docs/creative-director/schema-verification.md` |
| A-AI | `worker/src/creative/{roles,imageProvider,runnerProvider}.ts`, `scripts/eval/creative-*.mjs`, `docs/eval/creative-*.json`, `docs/eval/README-creative.md` |
| A-FACTS | `worker/src/creative/{facts,grounding,placementSpecs}.ts` (+tests), `src/lib/marketingOS/platformRules.ts` (PLACEMENT_SPECS + helpers, additive) |
| A-BRAND | `supabase/migrations/2026-09-02_26_creative_brand_kit_seed.sql`, `docs/brand/brand-kit.draft.json`, `docs/brand/brand-kit-notes.md`, `worker/src/creative/brandKit.ts`, `api/_lib/marketing/creative/brandKit.ts` |
| A-GEN | `worker/src/creative/director/**` (prompts, schemas, policy, adaptation planner, asset ranker, reference selector, orchestrator `runDirector.ts`) + tests |
| A-WORKER | `worker/src/creative/lanes/types.ts`, `lanes/creativeJobsLane.ts`, `lanes/creativeImageLane.ts`, `runCreativeJob.ts`, `runCreativeImageJob.ts`, `worker/src/creative/io.ts`, `worker/src/index.ts` (lane registration only), `worker/src/env.ts` (new keys only) |
| A-VIS | `.claude/skills/visual-design-read-slide/**`, `.claude/skills/visual-design-read-post/**`, `scripts/claude-study-runner.mjs` (handlers + kinds), `scripts/lib/visual-design-validate.mjs`, `worker/src/creative/designRead/**`, `worker/src/creative/lanes/designReadLane.ts`, `worker/src/creative/backfill.ts`, reads-on-publish hook (`api/_lib/marketing/creative/onPublished.ts` called from A-API's publish path — A-API adds the one call) |
| A-ASSETS | `worker/src/runEnrichmentJob.ts` (additive fields, v2 flag), `worker/src/creative/assetMeta/**`, `worker/src/creative/lanes/assetMetaLane.ts`, `src/pages/Files/library/FilePickerModal.tsx` (filters prop), `src/pages/Files/library/LibraryFilterBar.tsx` (aspect facet), `src/lib/files/library.ts` + `src/types/files.ts` (aspect filter), `api/_lib/marketing/creative/rights.ts` |
| A-API | `api/marketing-os.ts`, `api/marketing.ts` (dispatch blocks), `api/_lib/marketing/creative/**` except brandKit.ts/rights.ts/onPublished.ts (calls them), `src/lib/marketingOS/creativeClient.ts`, `src/lib/marketingOS/client.ts` (one export line + shared row types), `src/lib/competitorWatch/client.ts` (wrappers) |
| A-UI | everything under `src/pages/Marketing/components/creative/**`, settings components, `ContentDetailPage.tsx`, `MarketingWorkspace.tsx`, `src/App.tsx`, `src/pages/CompetitorWatch/components/ContentLibrary.tsx`, `docs/prd/marketing-workspace.md` + `competitor-watch.md` updates |
| A-QA (wave 3) | `worker/src/creative/__tests__/integration.*`, `scripts/creative-e2e.mjs`, security review notes `docs/creative-director/qa-report.md` |

## 13. Integration order
1. LEAD: contracts (this) + `contracts.ts` both copies. 2. Parallel: A-DB (apply live) · A-AI · A-FACTS · A-BRAND · A-GEN · A-WORKER · A-VIS · A-ASSETS · A-API · A-UI. Agents code against the names here; A-DB reports the applied schema; any mismatch → LEAD. 3. LEAD typechecks all three packages (`npm run typecheck`, `npm run typecheck:api`, `worker: npm run typecheck`), `npm test`, `worker npm test`. 4. A-QA + LEAD: integration/E2E on prod behind flags, eval pilot, five-project run, rollback test. 5. Report; commits/push only on the operator's word.

## 14. Conventions
Worker tests: vitest `__tests__/*.test.ts`, pure modules injectable (no network). Costs on every row. Timestamps ISO. Arabic normalisation via `normAr`. Errors prefixed. No `any`. Every migration idempotent (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `CREATE OR REPLACE`).
