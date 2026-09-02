# A-DB report — Post Creative Director schema

**Status: all owned files written. Nothing applied (no DB access in this environment). The lead applies `_20` → `_25` in order, then runs `docs/creative-director/schema-verification.sql` and pastes the output back.**

## Files created

| File | Contents |
|---|---|
| `supabase/migrations/2026-09-02_20_creative_jobs.sql` | `mos_creative_jobs` table + 7 queue RPCs |
| `supabase/migrations/2026-09-02_21_creative_packages.sql` | `mos_creative_packages` / `mos_creative_derivatives` / `mos_creative_refs` + 2 RPCs + updated_at trigger |
| `supabase/migrations/2026-09-02_22_visual_design_reads.sql` | `visual_design_reads` (+ generated columns, HNSW) + 3 RPCs incl. `mkt_creative_references` |
| `supabase/migrations/2026-09-02_23_design_examples_wassel_org.sql` | `mos_design_examples` + Wassel internal-org seed + `mkt_content_library` v5 |
| `supabase/migrations/2026-09-02_24_files_signals_rights.sql` | 5 `files` columns + `files_rights_v` + 2 asset RPCs |
| `supabase/migrations/2026-09-02_25_performance_flags_jobs.sql` | `mos_content_performance_v`, both job-kind CHECK re-lists, `claude_job_claim_next` re-issue, `creative_backfill_runs` + 2 RPCs, all `mos_settings` seeds |
| `docs/creative-director/schema-verification.sql` | read-only existence checks + sample calls for the lead to run post-apply |

All tables: RLS enabled, **no policies**. All RPCs: `SECURITY DEFINER SET search_path TO 'public'`, `REVOKE … FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE … TO service_role` (except the two views, granted `SELECT` to `authenticated, service_role`, `security_invoker=true`; and `mkt_content_library` whose existing grants survive CREATE OR REPLACE). Everything idempotent + additive.

## Final RPC signatures + return columns (code against these)

```sql
mos_creative_job_enqueue(p_content_id uuid, p_kind text, p_params jsonb, p_requested_by uuid) RETURNS uuid
  -- raises EXCEPTION 'active_job_exists' on the one-active-per-content conflict (A-API: map to 409)
mos_creative_job_claim_next(p_worker_id text)
  RETURNS TABLE(job_id uuid, content_id uuid, kind text, params jsonb, requested_by uuid, attempts int)
  -- FOR UPDATE SKIP LOCKED; sets lease_expires_at = now() + 10 min, attempts+1
mos_creative_job_stage(p_job_id uuid, p_stage text) RETURNS void            -- running rows only
mos_creative_job_complete(p_job_id uuid, p_result jsonb, p_roles jsonb, p_cost_usd numeric) RETURNS void
mos_creative_job_fail(p_job_id uuid, p_error text, p_error_kind text) RETURNS void
  -- requeues (status='queued', worker/lease cleared) while attempts < max_attempts
  -- AND p_error_kind IN ('provider','transient'); else terminal 'failed'
mos_creative_job_cancel(p_job_id uuid) RETURNS void                          -- queued → cancelled only
mos_creative_jobs_watchdog() RETURNS int                                     -- running with lapsed lease → failed/'watchdog'

mos_creative_package_next_version(p_content_id uuid) RETURNS int
mos_creative_package_patch(p_package_id uuid, p_path text[], p_value jsonb) RETURNS void
  -- UPDATE … SET base = jsonb_set(base, p_path, p_value, true), updated_at = now()

visual_design_read_upsert(p_subject_kind text, p_subject_id uuid, p_level text, p_post_id uuid,
  p_slide_index int, p_organization_id uuid, p_model_task text, p_model_used text, p_rule_version text,
  p_read jsonb, p_confidence numeric, p_cost_usd numeric, p_raw jsonb, p_status text, p_failure text,
  p_embedding vector(768) DEFAULT NULL) RETURNS uuid
  -- ON CONFLICT (subject_kind, subject_id, level, model_used, rule_version) updates
  -- read/confidence/cost_usd/raw/embedding/status/failure_reason

creative_design_read_targets(p_subject_kind text, p_level text, p_rule_version text,
  p_model_used text, p_tier int, p_limit int)
  RETURNS TABLE(subject_kind text, subject_id uuid, post_id uuid, slide_index int,
                organization_id uuid, stored_url text, post_type text)
  -- tiers 1–4 competitor statics (1 project-attributed & !general_branding ·
  -- 2 !general_branding & <12mo · 3 carousel · 4 rest); tier 5 = internal org
  -- ('wassel_content' post / 'wassel_file' slide). Excludes subjects that already
  -- have a read for (level, model_used, rule_version). p_subject_kind NULL = all.

mkt_creative_references(p_project_id uuid, p_district text, p_unit_types text[], p_purpose text[],
  p_intent jsonb, p_include_wassel boolean, p_qvec vector(768), p_limit int)
  RETURNS TABLE(ref_kind text, ref_id uuid, post_id uuid, slide_index int, level text,
                preview_url text, org_name text, platform text, published_at timestamptz,
                post_url text, score numeric, why jsonb, read jsonb)
  -- scoring: +3 purpose · +2 district · +1 unit overlap · +1 recency · −5 general
  -- branding (unless 'brand' ∈ p_purpose) · +2 PER matched intent key (format,
  -- layout, density, branding_intensity, palette_family vs latest post-level read)
  -- · +3×cosine (slide embedding; post = max over its slides) · +2 approved
  -- Wassel example (only when p_include_wassel) · tie-break likes · ≤2 per org.
  -- `read` = slide read for slide candidates (fallback post read), else post read.
  -- `why` lists every matched criterion (incl. project_match when
  -- enrichment.primary_project_id = p_project_id — no score term, see deviations).

creative_candidate_assets(p_project_id uuid, p_limit int DEFAULT 40)
  RETURNS TABLE(file_id uuid, original_name text, primary_category text, document_type text,
    link_role text, asset_nature text, acquisition_source text, usage_rights text,
    rights_provenance text, rights_verified boolean, production_state text,
    aspect_ratio text, width_px int, height_px int, ai_description text,
    tags text[], subjects text[], dominant_colors jsonb, has_text boolean,
    headline_space text, storage_bucket text, storage_path text, created_at timestamptz)
  -- project images via file_links (models.name='all_projects'), kind='image',
  -- not archived, usage_rights NOT IN ('restricted','do_not_use'); ordered
  -- verified+usable rights → developer/internal source → raw → real/cgi → recency.

creative_asset_backfill_targets(p_kind text, p_limit int DEFAULT 50)
  RETURNS TABLE(file_id uuid, storage_bucket text, storage_path text, mime_type text)
  -- 'meta': width_px OR dominant_colors missing · 'enrich': visual_meta_version
  -- IS DISTINCT FROM 'enrich-v2' (active-campaign projects → verified rights → recency)

creative_backfill_run_start(p_kind text, p_tier int, p_worker_id text) RETURNS uuid
creative_backfill_run_finish(p_run_id uuid, p_status text, p_processed int, p_failed int,
  p_cost_usd numeric, p_note text) RETURNS void                              -- running rows only
```

Also: `files_rights_v(file_id, usage_rights, rights_provenance, rights_verified, decided_by, decided_at)`; `mos_content_performance_v(content_id, publications, views, engagement, likes, comments, saves, enquiries, last_captured_at)`; `mkt_content_library` v5 (same signature/grants as v4; media `ORDER BY carousel_index`; internal org excluded).

## Job-kind CHECKs (re-listed in full, per the 2026-08-03 lesson)

- `generation_jobs`: `('image','video','audio','clean-text','video-convert','listing-mirror','creative-image')`
- `claude_jobs`: `('ping','client_study','mkt_content_enrichment','mkt_campaign_summary','whatsapp_reply','mkt_visual_ocr','aqar_listing_extract','mkt_visual_design_slide','mkt_visual_design_post')`
- `claude_job_claim_next`: both design kinds added to `v_ocr_kinds` (the existing OCR runner lease claims them) and `v_lease_kinds`.

## Settings seeds (`mos_settings`, all `ON CONFLICT DO NOTHING`)

- `creative_writer` — all five flags `false` (ship dark).
- `role_map` — `{design_owner:'montage', design_reviewer:'marketing_manager'}`.
- `creative_backfill` — exactly the brief's shape, everything disabled.
- `writer_rules` — `{shared:[7], post:[5], video:[4], decisions_log:[8]}` transcribed from both skills' hard rules + Decisions Logs. **A-BRAND: this is a real seed, not a placeholder — `_26` only needs `brand_kit`.**
- `ai_roles` — additive merge of the nine §5 keys (`value || new-keys-only`); a missing `ai_roles` row is created empty first, so this never replaces existing keys.

## Wassel internal org (operator action needed)

Seeded `mkt_organizations(name_en='Wassel Real Estate', org_type='internal')` + four `mkt_social_accounts` (instagram `wassel.re`, tiktok `wasselre`, snapchat `wasselre`, x `@wassel_sa`, provider 'apify') — **`collection_enabled=false` on all four by deliberate choice: the operator enables collection explicitly per account.** Guarded by NOT EXISTS (the unique key is an expression index `(platform, lower(handle))`, not a named constraint, so ON CONFLICT can't target it portably).

## Contract deviations (proposed / already encoded)

1. **`notification_rules` seed for `post_creative_ready` SKIPPED** (contract §2 `_25` had it; the brief's reading list says "do NOT seed rules — not needed"). In-app bell always fires via `notify_emit` without a rule row; no push/WhatsApp fan-out wanted. Same posture as the video lane's `video_script_ready`. Flagged in the `_25` header comment too.
2. **Intent-match scoring read as +2 PER matched key** (contract: "+2 when a read exists and matches p_intent keys (… count matches)"). Cap is therefore +10. `why.intent_matches` lists which keys matched.
3. **`p_project_id` has no score term** (no criterion in the brief uses it); confident attribution to it is surfaced as `why.project_match`.
4. **Cosine for post candidates = max over the post's slide embeddings** (embeddings live on slides); slide candidates use their own latest embedding.
5. **Tier 5 (internal org) restricted to `post_type IN ('image','carousel')`** — design reads are a statics system; video is owned by the `mkt_cv_*` pipeline.
6. **Two extra additive indexes** on `visual_design_reads` — `(level, post_id)` and `(level, subject_id)` — the contract's single `(subject_kind, level, post_id)` index doesn't serve the LATERAL "latest read per post/slide" lookups.
7. `files_rights_v` also exposes `decided_by`/`decided_at` (additive, useful for the rights UI tooltip).
8. `creative_candidate_assets` dedups multi-role links with `DISTINCT ON (file_id)` preferring a specific role over `'attachment'`.

## ⚠ One thing the lead MUST check before applying `_25`

`claude_job_claim_next` is re-issued from the **latest repo copy** (`2026-08-26_marketing_runner_slots.sql`) + the two design kinds, because I cannot read the live `pg_get_functiondef` (no DB access). That function has been edited in production more than once (2026-08-26's own header says so; note the 2026-07-29 aqar-lane arrays are NOT in the 2026-08-26 body — aqar jobs currently claim lease-free at priority 1). **Diff the live definition before applying; if the live body has drifted, re-emit it verbatim with only the two-kind addition.** The `_25` header carries this warning too.

## For other agents

- **A-VIS**: `claude_jobs` accepts + the OCR lease claims `mkt_visual_design_slide` / `mkt_visual_design_post` — implement the runner handlers (`scripts/claude-study-runner.mjs`, yours). Write reads via `visual_design_read_upsert` (model_used e.g. `'runner:visual-design-read-slide'` — your constant, keep it stable per rule_version or backfill resumes break).
- **A-WORKER**: `generation_jobs` admits `creative-image`. Claim via `mos_creative_job_claim_next`; fail with `error_kind` ∈ {provider, transient} to requeue, anything else is terminal; watchdog = 10-min lease.
- **A-ASSETS**: stamp `files.visual_meta_version='enrich-v2'` after v2 enrichment; backfill work lists come from `creative_asset_backfill_targets('meta'|'enrich', n)`; record runs via `creative_backfill_run_start/finish`.
- **A-API**: enqueue raises `'active_job_exists'` → 409. Reads (`creative_package_list/get`, `creative_performance`, backfill status) go through the service client — tables have no policies.

## Tests / typecheck

- No TypeScript owned → no typecheck applies (`npx tsc` untouched surfaces).
- **SQL was NOT executed**: this environment has no DB MCP, no psql, and sandboxed `node` (a JSON-literal validation script I wrote could not be run and was deleted). Verification is therefore manual review + the post-apply script. Review caught and fixed one real bug pre-delivery: `round(double precision, int)` doesn't exist in Postgres — `why.cosine` now casts to numeric first. `docs/creative-director/schema-verification.sql` covers: table/RLS/policy existence, RPC signatures, generated columns, CHECK contents (incl. the whatsapp_reply/aqar regression guards), claim_next lane membership, settings seeds (incl. flags dark + 9 ai_roles keys), Wassel org/accounts (collection off), and six sample calls (references, design targets, candidate assets, backfill targets ×2, performance view) plus carousel-order and internal-exclusion assertions on `mkt_content_library`.
