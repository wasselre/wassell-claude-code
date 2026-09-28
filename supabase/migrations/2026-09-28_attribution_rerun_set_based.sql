-- mkt_enqueue_attribution_rerun: set-based, so creating a project stops timing out.
--
-- Since 2026-09-14_01 every all_projects INSERT (and every rename / developer
-- change) runs mkt_enqueue_attribution_rerun(NULL, 20000) INSIDE the save. The
-- old body looped over ~3,500 posts and, for each one, ran
--   NOT EXISTS (… mkt_collection_jobs WHERE (params->>'content_post_id')::uuid = r.id)
-- which has no index, so every iteration scanned all ~70k jobs: ~245 million
-- row checks, measured 68.3 s on 2026-09-28. The app's record_save hits its
-- statement timeout long before that, so NO project could be created from the
-- app (the last successful one was 2026-09-07) — the save 500'd and rolled back.
--
-- Same behaviour, one pass: collect the in-flight content_process post ids ONCE
-- (hash anti-join), then insert the jobs in one statement. Identical to what the
-- loop produced because mkt_job_enqueue for content_process (no social account,
-- not paid_ads/discover_advertiser) is a plain INSERT with the max_attempts
-- setting, and mkt_content_enrichment is one row per post (unique content_post_id),
-- so the loop never met the same post twice.

BEGIN;

CREATE OR REPLACE FUNCTION public.mkt_enqueue_attribution_rerun(p_org uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 10000)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_count int := 0; v_max int;
BEGIN
  SELECT COALESCE((SELECT (value)::int FROM public.mkt_settings WHERE key = 'max_attempts'), 5) INTO v_max;

  WITH active AS (
    SELECT DISTINCT (j.params->>'content_post_id')::uuid AS post_id
      FROM public.mkt_collection_jobs j
     WHERE j.kind = 'content_process' AND j.status IN ('queued','running')
       AND j.params ? 'content_post_id'
  ), picked AS (
    SELECT cp.id, cp.organization_id
      FROM public.mkt_content_posts cp
      JOIN public.mkt_content_enrichment e ON e.content_post_id = cp.id
     WHERE (p_org IS NULL OR cp.organization_id = p_org)
       AND cp.processing_status IN ('processed','partial','awaiting_intelligence')
       AND cp.availability = 'available'
       AND e.attribution_locked_at IS NULL
     ORDER BY cp.published_at DESC NULLS LAST
     LIMIT GREATEST(0, p_limit)
  ), ins AS (
    INSERT INTO public.mkt_collection_jobs (kind, provider, social_account_id, params, priority, max_attempts, requested_by, fallback_of)
    SELECT 'content_process', 'internal', NULL,
           jsonb_build_object('content_post_id', p.id, 'organization_id', p.organization_id,
                              'from', 'attribution_rerun', 'mode', 'narrow_only'),
           40, v_max, NULL, NULL
      FROM picked p
     WHERE NOT EXISTS (SELECT 1 FROM active a WHERE a.post_id = p.id)
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;
  RETURN v_count;
END $function$;

COMMIT;
