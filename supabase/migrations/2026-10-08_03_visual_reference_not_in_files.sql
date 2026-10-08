-- 2026-10-08: content from VISUAL-REFERENCE companies (org_type
-- 'visual_reference': luxury, cars, fashion, hotels — followed only for their
-- visuals) never reaches Files or the app's business surfaces. Operator: "we
-- add the real estate companies to the live app, but the visuals no".
--
-- The Social-media -> Files bridge registers a collected post as files once
-- the post reader matches it to a project. Visual references are never read
-- now (runContentProcess.isVisualReferenceOrg), but one Mercedes-Benz post was
-- read and matched on 2026-10-05, the day BEFORE Mercedes became a visual
-- reference, so 5 of its images became "approved" files on a project — in
-- that project's Files tab and the WhatsApp file picker.
--
-- 1. social_file_enqueue refuses a visual-reference post (re-emitted verbatim
--    from the live definition, one block added).
-- 2. social_file_backfill skips them in its scan — otherwise the refusal would
--    end its loop early (it EXITs on the first NULL).
-- 3. Files already registered from visual references are unlinked
--    (mkt_content_media.file_id -> NULL, which marks the project's links dirty
--    and drops the derived 'social' link) and ARCHIVED. Nothing is deleted:
--    bytes and rows stay, and the competitor library still has the post.
BEGIN;

CREATE OR REPLACE FUNCTION public.social_file_enqueue(p_post uuid, p_reason text DEFAULT 'manual'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_job uuid; v_enabled boolean; v_cap int; v_depth int; v_missing int;
BEGIN
  SELECT is_enabled, max_queue_depth INTO v_enabled, v_cap FROM public.social_file_settings WHERE id;
  IF NOT COALESCE(v_enabled, false) THEN RETURN NULL; END IF;
  -- 2026-10-08: visual-reference brands (luxury / cars / fashion) never reach Files.
  IF EXISTS (SELECT 1 FROM public.mkt_content_posts p JOIN public.mkt_organizations o ON o.id = p.organization_id
              WHERE p.id = p_post AND o.org_type = 'visual_reference') THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.mkt_content_enrichment e
                  WHERE e.content_post_id = p_post AND e.status = 'done' AND e.primary_project_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  SELECT count(*) INTO v_missing FROM public.mkt_content_media m
   WHERE m.content_post_id = p_post AND m.download_status = 'stored' AND m.stored_path IS NOT NULL
     AND m.media_kind IN ('image','video') AND m.file_id IS NULL;
  IF v_missing = 0 THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.generation_jobs WHERE record_id = p_post AND kind = 'social-file' AND status IN ('queued','running')) THEN
    RETURN NULL;
  END IF;
  IF COALESCE(v_cap, 0) > 0 THEN
    SELECT count(*) INTO v_depth FROM public.generation_jobs WHERE kind = 'social-file' AND status = 'queued';
    IF v_depth >= v_cap THEN RETURN NULL; END IF;
  END IF;
  v_job := gen_random_uuid();
  INSERT INTO public.generation_jobs (id, record_id, message_id, user_id, kind, status, prompt, params)
  VALUES (v_job, p_post, NULL, NULL, 'social-file', 'queued', NULL,
          jsonb_build_object('post_id', p_post, 'reason', p_reason, 'missing_at_enqueue', v_missing));
  RETURN v_job;
END $function$;

CREATE OR REPLACE FUNCTION public.social_file_backfill(p_limit integer DEFAULT 50)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; n int := 0; j uuid;
BEGIN
  FOR r IN
    SELECT DISTINCT p.id, p.published_at
      FROM public.mkt_content_posts p
      JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done' AND e.primary_project_id IS NOT NULL
      JOIN public.mkt_content_media m ON m.content_post_id = p.id AND m.download_status = 'stored'
       AND m.stored_path IS NOT NULL AND m.media_kind IN ('image','video') AND m.file_id IS NULL
     WHERE NOT EXISTS (SELECT 1 FROM public.mkt_organizations o WHERE o.id = p.organization_id AND o.org_type = 'visual_reference')
       AND NOT EXISTS (SELECT 1 FROM public.generation_jobs g WHERE g.record_id = p.id AND g.kind = 'social-file' AND g.status IN ('queued','running'))
     ORDER BY p.published_at DESC NULLS LAST
     LIMIT GREATEST(0, p_limit)
  LOOP
    j := public.social_file_enqueue(r.id, 'backfill');
    IF j IS NOT NULL THEN n := n + 1; ELSE EXIT; END IF;
  END LOOP;
  RETURN n;
END $function$;

CREATE TEMP TABLE _vr_files ON COMMIT DROP AS
SELECT m.id AS media_id, m.file_id
  FROM public.mkt_content_media m
  JOIN public.mkt_content_posts p ON p.id = m.content_post_id
  JOIN public.mkt_organizations o ON o.id = p.organization_id
 WHERE o.org_type = 'visual_reference' AND m.file_id IS NOT NULL;

UPDATE public.mkt_content_media m SET file_id = NULL
  FROM _vr_files v WHERE m.id = v.media_id;

UPDATE public.files f SET status = 'archived', archived_at = now(), updated_at = now()
  FROM _vr_files v WHERE f.id = v.file_id AND f.status <> 'archived';

DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM public.mkt_content_media m
               JOIN public.mkt_content_posts p ON p.id = m.content_post_id
               JOIN public.mkt_organizations o ON o.id = p.organization_id
              WHERE o.org_type = 'visual_reference' AND m.file_id IS NOT NULL) THEN
    RAISE EXCEPTION 'VISUAL_REFERENCE_STILL_IN_FILES';
  END IF;
  IF pg_get_functiondef('public.social_file_enqueue(uuid,text)'::regprocedure) NOT LIKE '%visual_reference%' THEN
    RAISE EXCEPTION 'SOCIAL_FILE_ENQUEUE_NOT_FENCED';
  END IF;
END $assert$;

COMMIT;
