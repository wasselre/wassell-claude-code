-- Feed OUR OWN marketing assets (mos_assets) into the SAME visual pipeline as
-- competitors, so scene references and the visual library can search our own
-- footage by meaning. The worker lane (cv_embed_wassel: video -> /process;
-- photo -> /embed_images) was already built and claimed by cvProcessPollLoop.
-- This adds the MISSING enqueue side + a coverage status.
--
-- Our real videos (138 video/mp4) live PRIVATE in wassel-files (file_id), no
-- public url; the worker signs a URL at process time (allowed for OUR assets —
-- the "no signed urls" rule was for COMPETITOR videos). YouTube-linked "videos"
-- (117, mime NULL) are NOT fetchable and are excluded. Documents/audio too.
-- Photos (419) carry a public image url or are signed the same way.

-- Processable predicate, reused everywhere so enqueue / backlog / status agree.
--   video : a real video file we hold privately (mime video/*, has file_id)
--   photo : an image with any usable source (public url, thumb, or private file)
CREATE OR REPLACE FUNCTION public.mkt_cv_wassel_asset_processable(a public.mos_assets)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT a.archived_at IS NULL AND (
    (a.kind = 'video' AND a.mime_type ILIKE 'video/%' AND a.file_id IS NOT NULL)
    OR (a.kind = 'photo' AND (a.url IS NOT NULL OR a.thumb_url IS NOT NULL OR a.file_id IS NOT NULL))
  );
$$;

-- Idempotency + race safety for the per-asset video row.
CREATE UNIQUE INDEX IF NOT EXISTS mkt_cv_videos_wassel_asset
  ON public.mkt_cv_videos (wassel_asset_id) WHERE wassel_asset_id IS NOT NULL;

-- Enqueue ONE asset. Creates/finds its owner='wassel' video row FIRST (so the
-- cv_embed_wassel job carries a real video_id — the queue dedups on
-- (kind, video_id), which a null video_id would collapse to one global job),
-- then queues the job unless the asset is already fully indexed. source_url is
-- left as the public url when there is one; the WORKER re-resolves it (signing
-- private bytes) right before Modal, so a signature can never go stale in queue.
CREATE OR REPLACE FUNCTION public.mkt_cv_enqueue_wassel_asset(p_asset_id uuid, p_priority int DEFAULT 110)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE a public.mos_assets; v_id uuid; v_status text; v_url text;
BEGIN
  SELECT * INTO a FROM public.mos_assets WHERE id = p_asset_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'permanent: mos_assets % not found', p_asset_id; END IF;
  IF NOT public.mkt_cv_wassel_asset_processable(a) THEN
    RAISE EXCEPTION 'permanent: mos_assets % (kind %, mime %) is not a processable video/photo', p_asset_id, a.kind, a.mime_type; END IF;
  v_url := COALESCE(a.url, a.thumb_url);  -- may be NULL for private video; worker signs

  SELECT id, status INTO v_id, v_status FROM public.mkt_cv_videos WHERE wassel_asset_id = p_asset_id;
  IF v_id IS NULL THEN
    INSERT INTO public.mkt_cv_videos (owner, wassel_asset_id, source_url, status)
    VALUES ('wassel', p_asset_id, v_url, 'queued')
    RETURNING id, status INTO v_id, v_status;
  ELSIF v_status NOT IN ('processing','analyzing','analyzed') THEN
    UPDATE public.mkt_cv_videos SET source_url = v_url, status = 'queued', error = NULL, updated_at = now()
     WHERE id = v_id;
  END IF;

  IF v_status IS DISTINCT FROM 'analyzed' THEN
    PERFORM public.mkt_cv_job_enqueue('cv_embed_wassel', v_id, NULL, jsonb_build_object('asset_id', p_asset_id), p_priority);
  END IF;
  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.mkt_cv_enqueue_wassel_asset(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_cv_enqueue_wassel_asset(uuid, int) TO service_role;

-- Bulk: enqueue the next N un-indexed processable assets (optionally one project
-- / kinds). Videos first, newest first. The daily cost cap + budget guard still
-- throttle processing — this only fills the queue.
CREATE OR REPLACE FUNCTION public.mkt_cv_enqueue_wassel_backlog(
  p_limit int DEFAULT 5, p_project_id uuid DEFAULT NULL, p_kinds text[] DEFAULT ARRAY['video','photo'])
RETURNS TABLE (asset_id uuid, video_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT a.id
      FROM public.mos_assets a
     WHERE a.kind = ANY(p_kinds)
       AND public.mkt_cv_wassel_asset_processable(a)
       AND (p_project_id IS NULL OR a.project_id = p_project_id)
       AND NOT EXISTS (SELECT 1 FROM public.mkt_cv_videos v
                        WHERE v.wassel_asset_id = a.id AND v.status IN ('analyzed','processing','analyzing'))
       AND NOT EXISTS (SELECT 1 FROM public.mkt_cv_jobs j JOIN public.mkt_cv_videos v ON v.id = j.video_id
                        WHERE v.wassel_asset_id = a.id AND j.kind = 'cv_embed_wassel' AND j.status IN ('queued','running'))
     ORDER BY (a.kind = 'video') DESC, a.created_at DESC
     LIMIT GREATEST(p_limit, 0)
  LOOP
    asset_id := r.id;
    video_id := public.mkt_cv_enqueue_wassel_asset(r.id, 110);
    RETURN NEXT;
  END LOOP;
END; $$;
REVOKE ALL ON FUNCTION public.mkt_cv_enqueue_wassel_backlog(int, uuid, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_cv_enqueue_wassel_backlog(int, uuid, text[]) TO service_role;

-- Coverage: how much of our own library is visually indexed. One row per
-- processable asset, joined to its video.
CREATE OR REPLACE FUNCTION public.mkt_cv_wassel_status(p_project_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'eligible',    count(*),
    'videos',      count(*) FILTER (WHERE kind = 'video'),
    'images',      count(*) FILTER (WHERE kind = 'photo'),
    'indexed',     count(*) FILTER (WHERE vstatus IN ('analyzed','partial')),
    'processing',  count(*) FILTER (WHERE vstatus IN ('queued','processing','analyzing','frames_done')),
    'failed',      count(*) FILTER (WHERE vstatus = 'failed'),
    'not_started', count(*) FILTER (WHERE vstatus IS NULL)
  )
  FROM (
    SELECT a.kind, v.status AS vstatus
      FROM public.mos_assets a
      LEFT JOIN public.mkt_cv_videos v ON v.wassel_asset_id = a.id
     WHERE public.mkt_cv_wassel_asset_processable(a)
       AND (p_project_id IS NULL OR a.project_id = p_project_id)
  ) t;
$$;
REVOKE ALL ON FUNCTION public.mkt_cv_wassel_status(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mkt_cv_wassel_status(uuid) TO service_role, authenticated;
