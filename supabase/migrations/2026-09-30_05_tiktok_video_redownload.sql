-- ============================================================================
-- TikTok videos that never got their file (2026-09-30)
-- ----------------------------------------------------------------------------
-- TikTok is collected in two passes: a metadata pass, then a download pass for
-- the NEW videos of that run. A video whose download pass never delivered a
-- file is recorded as media 'failed' — and nothing ever went back for it.
-- Measured: 175 of 548 TikTok videos (Riva 124 of 236), 141 of them from the
-- first bulk pull on 22–27 July. No file means no transcript and no frame text.
--
-- The download pass takes post links, so the recovery is the same actor run with
-- the old links:
--   mkt_tiktok_videos_missing(account, limit, max_attempts)  what to ask for
--   mkt_tiktok_redownload_mark(post_ids)                     one attempt spent
--   mkt_enqueue_tiktok_redownloads()                         the standing repair —
--       called by the content sweep; enqueues at most one bounded job per
--       account per 20 h, and ONLY while Apify is enabled and not paused, so it
--       can never spend while collection is stopped.
-- Attempts are capped (3) per video: a video its owner deleted cannot be
-- recovered, and must not be re-bought forever.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '8s';

ALTER TABLE public.mkt_content_media
  ADD COLUMN IF NOT EXISTS redownload_attempts integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.mkt_content_media.redownload_attempts IS
  'TikTok video rows only: how many times a download-pass re-run was spent on this missing file (capped — see mkt_tiktok_videos_missing).';

CREATE OR REPLACE FUNCTION public.mkt_tiktok_videos_missing(p_account uuid, p_limit integer DEFAULT 25, p_max_attempts integer DEFAULT 3)
RETURNS TABLE (post_id uuid, external_id text, post_url text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT p.id, p.external_id, p.post_url
    FROM public.mkt_content_posts p
    JOIN public.mkt_content_media m
      ON m.content_post_id = p.id AND m.media_kind = 'video' AND m.download_status = 'failed'
   WHERE p.platform = 'tiktok'
     AND p.social_account_id = p_account
     AND p.availability = 'available'
     AND nullif(p.post_url, '') IS NOT NULL
     AND m.redownload_attempts < GREATEST(1, p_max_attempts)
     AND NOT EXISTS (SELECT 1 FROM public.mkt_content_media s
                      WHERE s.content_post_id = p.id AND s.media_kind = 'video' AND s.download_status = 'stored')
   ORDER BY p.published_at DESC NULLS LAST, p.id
   LIMIT GREATEST(0, p_limit);
$$;

CREATE OR REPLACE FUNCTION public.mkt_tiktok_redownload_mark(p_post_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE n integer;
BEGIN
  UPDATE public.mkt_content_media
     SET redownload_attempts = redownload_attempts + 1, updated_at = now()
   WHERE content_post_id = ANY (coalesce(p_post_ids, '{}'::uuid[]))
     AND media_kind = 'video' AND download_status = 'failed';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.mkt_enqueue_tiktok_redownloads(p_max_jobs integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE r record; n integer := 0;
BEGIN
  -- Never while collection is stopped: this path costs money.
  IF NOT EXISTS (SELECT 1 FROM public.mkt_providers pr
                  WHERE pr.provider_key = 'apify' AND pr.is_enabled
                    AND (pr.paused_until IS NULL OR pr.paused_until <= now())) THEN
    RETURN 0;
  END IF;

  FOR r IN
    SELECT a.id
      FROM public.mkt_social_accounts a
     WHERE a.platform = 'tiktok' AND a.provider = 'apify' AND a.is_active AND a.collection_enabled
       AND EXISTS (SELECT 1 FROM public.mkt_tiktok_videos_missing(a.id, 1, 3))
       AND NOT EXISTS (SELECT 1 FROM public.mkt_collection_jobs j
                        WHERE j.social_account_id = a.id AND j.params->>'mode' = 'tiktok_redownload'
                          AND (j.status IN ('queued', 'running') OR j.created_at > now() - interval '20 hours'))
     ORDER BY a.id
     LIMIT GREATEST(0, p_max_jobs)
  LOOP
    PERFORM public.mkt_job_enqueue('backfill', 'apify', r.id,
      jsonb_build_object('mode', 'tiktok_redownload', 'limit', 25, 'reason', 'sweep'), 90);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.mkt_tiktok_videos_missing(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mkt_tiktok_redownload_mark(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mkt_enqueue_tiktok_redownloads(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_tiktok_videos_missing(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_tiktok_redownload_mark(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.mkt_enqueue_tiktok_redownloads(integer) TO service_role;

COMMIT;
