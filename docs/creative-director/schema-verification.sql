-- ============================================================================
-- Post Creative Director — schema verification (run AFTER applying
-- 2026-09-02_20 … _25). Read-only: every statement is a SELECT; sample calls
-- that find no data simply return empty results, which is a PASS.
--
-- How to read the output: every "CHECK …" query must return `t` (true) or a
-- non-zero count. The "SAMPLE …" queries are smoke calls — they must not
-- raise; zero rows is fine on a fresh apply.
-- ============================================================================

-- ── 1. tables exist ─────────────────────────────────────────────────────────
SELECT 'CHECK tables' AS check, count(*) AS found, 8 AS expected
  FROM pg_tables
 WHERE schemaname = 'public'
   AND tablename IN ('mos_creative_jobs','mos_creative_packages','mos_creative_derivatives',
                     'mos_creative_refs','visual_design_reads','mos_design_examples',
                     'creative_backfill_runs');

-- ── 2. RLS enabled, no policies on the new tables ───────────────────────────
SELECT 'CHECK rls_enabled' AS check, count(*) AS found, 7 AS expected
  FROM pg_tables
 WHERE schemaname = 'public'
   AND tablename IN ('mos_creative_jobs','mos_creative_packages','mos_creative_derivatives',
                     'mos_creative_refs','visual_design_reads','mos_design_examples',
                     'creative_backfill_runs')
   AND rowsecurity = true;

SELECT 'CHECK no_policies' AS check, count(*) AS found, 0 AS expected
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('mos_creative_jobs','mos_creative_packages','mos_creative_derivatives',
                     'mos_creative_refs','visual_design_reads','mos_design_examples',
                     'creative_backfill_runs');

-- ── 3. RPCs exist with the contracted signatures ────────────────────────────
SELECT 'CHECK rpcs' AS check, p.proname,
       pg_get_function_identity_arguments(p.oid) AS args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'mos_creative_job_enqueue','mos_creative_job_claim_next','mos_creative_job_stage',
     'mos_creative_job_complete','mos_creative_job_fail','mos_creative_job_cancel',
     'mos_creative_jobs_watchdog',
     'mos_creative_package_next_version','mos_creative_package_patch',
     'visual_design_read_upsert','creative_design_read_targets','mkt_creative_references',
     'creative_candidate_assets','creative_asset_backfill_targets',
     'creative_backfill_run_start','creative_backfill_run_finish',
     'mkt_content_library','claude_job_claim_next'
   )
 ORDER BY p.proname;

-- ── 4. files columns + views ────────────────────────────────────────────────
SELECT 'CHECK files_columns' AS check, count(*) AS found, 5 AS expected
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'files'
   AND column_name IN ('dominant_colors','has_text','headline_space','ocr_text','visual_meta_version');

SELECT 'CHECK views' AS check, count(*) AS found, 2 AS expected
  FROM pg_views
 WHERE schemaname = 'public'
   AND viewname IN ('files_rights_v','mos_content_performance_v');

-- visual_design_reads generated columns
SELECT 'CHECK reads_generated_cols' AS check, count(*) AS found, 6 AS expected
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'visual_design_reads'
   AND column_name IN ('layout_family','density','branding_intensity','palette_family','format','slide_role')
   AND is_generated = 'ALWAYS';

-- ── 5. job-kind CHECKs re-listed ────────────────────────────────────────────
SELECT 'CHECK generation_jobs_kind' AS check,
       pg_get_constraintdef(oid) LIKE '%creative-image%' AS pass
  FROM pg_constraint WHERE conname = 'generation_jobs_kind_check';

SELECT 'CHECK claude_jobs_kind' AS check,
       pg_get_constraintdef(oid) LIKE '%mkt_visual_design_slide%'
       AND pg_get_constraintdef(oid) LIKE '%mkt_visual_design_post%'
       AND pg_get_constraintdef(oid) LIKE '%whatsapp_reply%'        -- regression guard (2026-08-03 lesson)
       AND pg_get_constraintdef(oid) LIKE '%aqar_listing_extract%'  AS pass
  FROM pg_constraint WHERE conname = 'claude_jobs_kind_check';

-- claude_job_claim_next serves the design kinds on the OCR lane
SELECT 'CHECK claim_next_ocr_lane' AS check,
       pg_get_functiondef(p.oid) LIKE '%mkt_visual_design_slide%'
       AND pg_get_functiondef(p.oid) LIKE '%mkt_visual_design_post%' AS pass
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'claude_job_claim_next';

-- ── 6. settings seeds ───────────────────────────────────────────────────────
SELECT 'CHECK settings' AS check, key, value IS NOT NULL AS present
  FROM mos_settings
 WHERE key IN ('creative_writer','role_map','creative_backfill','writer_rules','ai_roles')
 ORDER BY key;

SELECT 'CHECK ai_roles_keys' AS check, count(*) AS found, 9 AS expected
  FROM mos_settings, jsonb_object_keys(value) k
 WHERE key = 'ai_roles'
   AND k IN ('creative_concepts','creative_package','creative_derivatives',
             'design_read_slide','design_read_post','asset_enrich_v2',
             'image_edit','image_generate','image_remove_text');

SELECT 'CHECK flags_dark' AS check,
       (NOT (value->>'post_enabled')::boolean)
       AND (NOT (value->>'ai_image_execution')::boolean)
       AND (NOT (value->>'design_reads_enabled')::boolean)
       AND (NOT (value->>'asset_enrich_v2')::boolean)
       AND (NOT (value->>'backfill_enabled')::boolean) AS pass
  FROM mos_settings WHERE key = 'creative_writer';

-- ── 7. Wassel internal org + accounts (collection OFF) ──────────────────────
SELECT 'CHECK wassel_org' AS check, id, org_type, name_en, status
  FROM mkt_organizations
 WHERE name_en = 'Wassel Real Estate';

SELECT 'CHECK wassel_accounts' AS check, platform, handle, provider, is_active,
       collection_enabled   -- must ALL be false: the operator enables collection explicitly
  FROM mkt_social_accounts sa
  JOIN mkt_organizations o ON o.id = sa.organization_id
 WHERE o.name_en = 'Wassel Real Estate'
 ORDER BY platform;

-- ── 8. SAMPLE calls (must not raise; empty is OK) ───────────────────────────

-- reference retrieval, no vectors, launch-purpose only
SELECT 'SAMPLE mkt_creative_references' AS sample, *
  FROM mkt_creative_references(
    null, null, null, array['project_launch'], '{}'::jsonb, false, null, 5);

-- design-read backfill targets, tier 1, slide level
SELECT 'SAMPLE creative_design_read_targets' AS sample, *
  FROM creative_design_read_targets('competitor_media','slide','v1','none',1,5);

-- candidate assets for a real project (first all_projects record)
SELECT 'SAMPLE creative_candidate_assets' AS sample, *
  FROM creative_candidate_assets(
    (SELECT id FROM unified_records
      WHERE model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f' LIMIT 1), 5);

-- asset backfill targets, both kinds
SELECT 'SAMPLE creative_asset_backfill_targets meta' AS sample, *
  FROM creative_asset_backfill_targets('meta', 5);
SELECT 'SAMPLE creative_asset_backfill_targets enrich' AS sample, *
  FROM creative_asset_backfill_targets('enrich', 5);

-- performance view shape
SELECT 'SAMPLE mos_content_performance_v' AS sample, *
  FROM mos_content_performance_v LIMIT 3;

-- package helpers (read-only forms)
SELECT 'SAMPLE next_version' AS sample,
       mos_creative_package_next_version(null) AS v;   -- null content → 1, no rows touched

-- ── 9. carousel media order from mkt_content_library v5 ─────────────────────
-- Pick a recent enriched carousel post with ≥ 2 stored media, then assert the
-- library's media array follows carousel_index order. pass = NULL means the
-- post was not on the library's first page (or none exists) — investigate, do
-- not assume success.
WITH car AS (
  SELECT p.id
    FROM mkt_content_posts p
    JOIN mkt_organizations o        ON o.id = p.organization_id AND o.org_type <> 'internal'
    JOIN mkt_content_enrichment e   ON e.content_post_id = p.id AND e.status = 'done'
   WHERE p.post_type = 'carousel'
     AND (SELECT count(*) FROM mkt_content_media m
           WHERE m.content_post_id = p.id
             AND m.media_kind IN ('image','video')
             AND m.download_status = 'stored' AND m.stored_url IS NOT NULL) >= 2
   ORDER BY p.published_at DESC NULLS LAST
   LIMIT 1
),
expected AS (
  SELECT jsonb_agg(m.stored_url ORDER BY m.carousel_index) AS urls
    FROM mkt_content_media m
   WHERE m.content_post_id = (SELECT id FROM car)
     AND m.media_kind IN ('image','video')
     AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
),
actual AS (
  SELECT (SELECT jsonb_agg(x->>'url') FROM jsonb_array_elements(r->'media') x) AS urls
    FROM (SELECT mkt_content_library(NULL, NULL, 'carousel', NULL, NULL, NULL, 200, 0) AS j) s,
         LATERAL jsonb_array_elements(s.j->'rows') r
   WHERE (r->>'id')::uuid = (SELECT id FROM car)
   LIMIT 1
)
SELECT 'CHECK library_carousel_order' AS check,
       (SELECT id FROM car) AS carousel_post,
       (expected.urls = actual.urls) AS pass
  FROM expected, actual;

-- ── 10. internal org excluded from the competitor library ───────────────────
SELECT 'CHECK library_excludes_internal' AS check,
       NOT EXISTS (
         SELECT 1
           FROM (SELECT mkt_content_library(NULL, NULL, NULL, NULL, NULL, NULL, 200, 0) AS j) s,
                LATERAL jsonb_array_elements(s.j->'rows') r
           JOIN mkt_organizations o ON o.id = (r->>'organization_id')::uuid
          WHERE o.org_type = 'internal'
       ) AS pass;
