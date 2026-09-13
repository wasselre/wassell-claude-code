-- ============================================================================
-- Social-media intake → Files bridge (2026-09-13)
--
-- Competitor Watch already downloads every collected post's photos and videos
-- (mkt_content_media → public marketing-assets bucket). Nothing registered them
-- in the Files system, so a project's Files tab, the Business Library and the
-- WhatsApp file picker never saw them. This migration is the DB half of the
-- bridge (the worker lane `social-file` copies the bytes and inserts `files`):
--
--   1. settings (kill switch, queue cap, who owns the files, root folder)
--   2. mkt_content_media.file_id — the media row remembers its files row
--   3. files.origin 'social_intake' (+ the Files AI enrichment skips it — the
--      competitor pipeline already read these pixels)
--   4. a FIFTH derived origin 'social' in the file_links projection, keyed on
--      the media row + the enrichment's project pointer — so a human
--      re-attribution MOVES the link, nothing goes stale
--   5. mark-dirty triggers on both source tables
--   6. generation_jobs kind 'social-file' + enqueue / backfill RPCs, enqueued
--      automatically when a post gets a project (trigger) or its media lands
--   7. Library exposes files_registered
--
-- Ships DARK (is_enabled=false); the operator flips it after the worker lane
-- is deployed. Idempotent.
-- ============================================================================
BEGIN;

-- ── 1. settings ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.social_file_settings (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  is_enabled      boolean NOT NULL DEFAULT false,
  max_queue_depth int     NOT NULL DEFAULT 200,
  -- the files' uploader (public.users id) and the storage-path prefix (auth uid)
  owner_user_id   uuid REFERENCES public.users(id),
  owner_auth_uid  uuid,
  root_folder_id  uuid REFERENCES public.folders(id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.social_file_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.social_file_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.social_file_settings TO service_role;

-- the root folder the intake files live under (per-company subfolders are
-- created lazily by the worker)
INSERT INTO public.folders (id, parent_folder_id, name, created_by_user_id)
SELECT '9d1c2b3a-4e5f-4a6b-8c7d-2026091300a1', NULL, 'محتوى وسائل التواصل — المطوّرون والمنافسون', u.id
  FROM public.users u WHERE u.email = 'r.abanumay@wassel.re'
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.social_file_settings (id, is_enabled, max_queue_depth, owner_user_id, owner_auth_uid, root_folder_id)
SELECT true, false, 200, u.id, u.auth_uid, '9d1c2b3a-4e5f-4a6b-8c7d-2026091300a1'
  FROM public.users u WHERE u.email = 'r.abanumay@wassel.re'
ON CONFLICT (id) DO NOTHING;

-- ── 2. media → file pointer ─────────────────────────────────────────────────
ALTER TABLE public.mkt_content_media
  ADD COLUMN IF NOT EXISTS file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS file_registered_at timestamptz;
CREATE INDEX IF NOT EXISTS mkt_content_media_file_idx ON public.mkt_content_media (file_id) WHERE file_id IS NOT NULL;

-- ── 3. files.origin 'social_intake' + skip the paid Files AI read ───────────
ALTER TABLE public.files DROP CONSTRAINT IF EXISTS files_origin_chk;
ALTER TABLE public.files ADD CONSTRAINT files_origin_chk
  CHECK (origin IN ('user_upload','marketing_intake','integration_inbound',
                    'generated_document','derived_rendition','system_artifact','social_intake'));

CREATE OR REPLACE FUNCTION public.tg_files_enqueue_enrichment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Social-intake files arrive with their description, type and facts already
  -- read by the competitor pipeline (OCR + enrichment). Reading them again
  -- with the metered Files AI would cost money for nothing.
  IF NEW.origin = 'social_intake' THEN RETURN NEW; END IF;
  PERFORM public.file_enrichment_enqueue(NEW.id, 'upload');  -- no-op while disabled
  RETURN NEW;
END $$;

-- ── 4. the fifth derived origin in the projection ───────────────────────────
ALTER TABLE public.file_link_sources DROP CONSTRAINT IF EXISTS file_link_sources_origin_check;
ALTER TABLE public.file_link_sources ADD CONSTRAINT file_link_sources_origin_check
  CHECK (origin IN ('field','attachment','manual','marketing','social'));

-- Re-emitted from the live definition (2026-08-19_12) with ONE addition: the
-- 'social' UNION. Key = social:<media id>:<file id>:<all_projects model>:<project>.
CREATE OR REPLACE FUNCTION public.file_link_live_sources()
 RETURNS TABLE(source_key text, origin text, file_id uuid, model_id uuid, record_id uuid, role text, source_field text, source_position integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH field_valid AS (
    SELECT o.model_id, o.record_id, o.raw_value::uuid AS file_id, o.field,
           o.source_position, o.role
      FROM public.file_link_field_occurrences() o
     WHERE o.class = 'file'
  ),
  tri AS (
    SELECT fv.file_id, fv.model_id, fv.record_id,
           count(DISTINCT fv.role) AS n_roles,
           min(fv.role)            AS only_role
      FROM field_valid fv
     GROUP BY 1,2,3
  )
  SELECT 'field:'||fv.model_id||':'||fv.record_id||':'||fv.field||':'||fv.source_position||':'||fv.file_id,
         'field', fv.file_id, fv.model_id, fv.record_id, fv.role, fv.field, fv.source_position
    FROM field_valid fv
  UNION ALL
  SELECT 'attachment:'||fi.id||':'||fi.model_id||':'||fi.record_id,
         'attachment', fi.id, fi.model_id, fi.record_id,
         CASE WHEN t.n_roles = 1 THEN t.only_role ELSE 'attachment' END,
         NULL, NULL
    FROM public.files fi
    LEFT JOIN tri t
      ON t.file_id = fi.id AND t.model_id = fi.model_id AND t.record_id = fi.record_id
   WHERE fi.record_id IS NOT NULL AND fi.model_id IS NOT NULL
  UNION ALL
  SELECT 'manual:'||dl.file_id||':'||dl.model_id||':'||dl.record_id,
         'manual', dl.file_id, dl.model_id, dl.record_id,
         coalesce(dl.role, 'supporting_document'), NULL, NULL
    FROM public.document_links dl
   WHERE dl.model_id IS NOT NULL AND dl.record_id IS NOT NULL AND dl.file_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = dl.file_id)
  UNION ALL
  SELECT 'marketing:'||a.id||':'||a.file_id||':'||mp.id||':'||a.project_id,
         'marketing', a.file_id, mp.id, a.project_id, 'marketing_asset', NULL, NULL
    FROM public.mos_assets a
    CROSS JOIN LATERAL (SELECT id FROM public.models WHERE name='all_projects') mp
   WHERE a.file_id IS NOT NULL AND a.project_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = a.file_id)
  UNION ALL
  SELECT 'social:'||m.id||':'||m.file_id||':'||mp.id||':'||e.primary_project_id,
         'social', m.file_id, mp.id, e.primary_project_id, 'social_post', NULL, m.carousel_index
    FROM public.mkt_content_media m
    JOIN public.mkt_content_enrichment e
      ON e.content_post_id = m.content_post_id AND e.status = 'done' AND e.primary_project_id IS NOT NULL
    CROSS JOIN LATERAL (SELECT id FROM public.models WHERE name='all_projects') mp
   WHERE m.file_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = m.file_id);
$function$;

CREATE OR REPLACE FUNCTION public.file_link_live_sources_scoped(p_model_id uuid, p_record_id uuid)
 RETURNS TABLE(source_key text, origin text, file_id uuid, model_id uuid, record_id uuid, role text, source_field text, source_position integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET jit TO 'off'
AS $function$
  WITH field_valid AS (
    SELECT o.model_id, o.record_id, o.raw_value::uuid AS file_id, o.field,
           o.source_position, o.role
      FROM public.file_link_field_occurrences_scoped(p_model_id, p_record_id) o
     WHERE o.class = 'file'
  ),
  tri AS (
    SELECT fv.file_id, fv.model_id, fv.record_id,
           count(DISTINCT fv.role) AS n_roles,
           min(fv.role)            AS only_role
      FROM field_valid fv
     GROUP BY 1,2,3
  )
  SELECT 'field:'||fv.model_id||':'||fv.record_id||':'||fv.field||':'||fv.source_position||':'||fv.file_id,
         'field', fv.file_id, fv.model_id, fv.record_id, fv.role, fv.field, fv.source_position
    FROM field_valid fv
  UNION ALL
  SELECT 'attachment:'||fi.id||':'||fi.model_id||':'||fi.record_id,
         'attachment', fi.id, fi.model_id, fi.record_id,
         CASE WHEN t.n_roles = 1 THEN t.only_role ELSE 'attachment' END,
         NULL, NULL
    FROM public.files fi
    LEFT JOIN tri t
      ON t.file_id = fi.id AND t.model_id = fi.model_id AND t.record_id = fi.record_id
   WHERE fi.record_id IS NOT NULL AND fi.model_id IS NOT NULL
     AND fi.model_id  = p_model_id
     AND fi.record_id = p_record_id
  UNION ALL
  SELECT 'manual:'||dl.file_id||':'||dl.model_id||':'||dl.record_id,
         'manual', dl.file_id, dl.model_id, dl.record_id,
         coalesce(dl.role, 'supporting_document'), NULL, NULL
    FROM public.document_links dl
   WHERE dl.model_id IS NOT NULL AND dl.record_id IS NOT NULL AND dl.file_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = dl.file_id)
     AND dl.model_id  = p_model_id
     AND dl.record_id = p_record_id
  UNION ALL
  SELECT 'marketing:'||a.id||':'||a.file_id||':'||mp.id||':'||a.project_id,
         'marketing', a.file_id, mp.id, a.project_id, 'marketing_asset', NULL, NULL
    FROM public.mos_assets a
    CROSS JOIN LATERAL (SELECT id FROM public.models WHERE name='all_projects') mp
   WHERE a.file_id IS NOT NULL AND a.project_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = a.file_id)
     AND mp.id        = p_model_id
     AND a.project_id = p_record_id
  UNION ALL
  SELECT 'social:'||m.id||':'||m.file_id||':'||mp.id||':'||e.primary_project_id,
         'social', m.file_id, mp.id, e.primary_project_id, 'social_post', NULL, m.carousel_index
    FROM public.mkt_content_media m
    JOIN public.mkt_content_enrichment e
      ON e.content_post_id = m.content_post_id AND e.status = 'done' AND e.primary_project_id IS NOT NULL
    CROSS JOIN LATERAL (SELECT id FROM public.models WHERE name='all_projects') mp
   WHERE m.file_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = m.file_id)
     AND mp.id                = p_model_id
     AND e.primary_project_id = p_record_id;
$function$;

-- ── 5. mark-dirty triggers on the two social sources ────────────────────────
CREATE OR REPLACE FUNCTION public.tg_mkt_content_media_sync_file_links()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' SET jit = 'off' AS $$
DECLARE v_ap uuid; v_project uuid; v_post uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.file_id IS NOT DISTINCT FROM NEW.file_id THEN RETURN NULL; END IF;
  v_post := CASE WHEN TG_OP = 'DELETE' THEN OLD.content_post_id ELSE NEW.content_post_id END;
  IF (TG_OP = 'DELETE' AND OLD.file_id IS NULL) THEN RETURN NULL; END IF;
  SELECT id INTO v_ap FROM public.models WHERE name = 'all_projects';
  SELECT e.primary_project_id INTO v_project FROM public.mkt_content_enrichment e WHERE e.content_post_id = v_post;
  IF v_ap IS NULL OR v_project IS NULL THEN RETURN NULL; END IF;
  PERFORM public.file_links_mark_dirty(v_ap, v_project);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS mkt_content_media_sync_file_links ON public.mkt_content_media;
CREATE TRIGGER mkt_content_media_sync_file_links
  AFTER INSERT OR UPDATE OF file_id OR DELETE ON public.mkt_content_media
  FOR EACH ROW EXECUTE FUNCTION public.tg_mkt_content_media_sync_file_links();

CREATE OR REPLACE FUNCTION public.tg_mkt_content_enrichment_sync_file_links()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' SET jit = 'off' AS $$
DECLARE v_ap uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.primary_project_id IS NOT DISTINCT FROM NEW.primary_project_id
     AND OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NULL;
  END IF;
  -- only posts that have registered files can have social edges
  IF NOT EXISTS (SELECT 1 FROM public.mkt_content_media m WHERE m.content_post_id = NEW.content_post_id AND m.file_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;
  SELECT id INTO v_ap FROM public.models WHERE name = 'all_projects';
  IF v_ap IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.primary_project_id IS NOT NULL THEN
    PERFORM public.file_links_mark_dirty(v_ap, OLD.primary_project_id);
  END IF;
  IF NEW.primary_project_id IS NOT NULL THEN
    PERFORM public.file_links_mark_dirty(v_ap, NEW.primary_project_id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS mkt_content_enrichment_sync_file_links ON public.mkt_content_enrichment;
CREATE TRIGGER mkt_content_enrichment_sync_file_links
  AFTER INSERT OR UPDATE OF primary_project_id, status ON public.mkt_content_enrichment
  FOR EACH ROW EXECUTE FUNCTION public.tg_mkt_content_enrichment_sync_file_links();

-- ── 6. the queue: generation_jobs kind 'social-file' ────────────────────────
-- enqueued by triggers / the sweep, not by a person — same exemption as listing-mirror
ALTER TABLE public.generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_user_required_check;
ALTER TABLE public.generation_jobs ADD CONSTRAINT generation_jobs_user_required_check
  CHECK (user_id IS NOT NULL OR kind IN ('listing-mirror', 'social-file'));
ALTER TABLE public.generation_jobs DROP CONSTRAINT IF EXISTS generation_jobs_kind_check;
ALTER TABLE public.generation_jobs ADD CONSTRAINT generation_jobs_kind_check
  CHECK (kind = ANY (ARRAY['image','video','audio','clean-text','video-convert','listing-mirror','creative-image','meta-ad','social-file']));

-- One job per post. Refuses (returns NULL) when: disabled, the post has no
-- project, nothing is left to register, a job is already active, or the queue
-- is at its cap — turning a post away costs nothing, the backlog lives in the
-- DATA (media rows with file_id NULL) and the sweep picks it up later.
CREATE OR REPLACE FUNCTION public.social_file_enqueue(p_post uuid, p_reason text DEFAULT 'manual')
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_job uuid; v_enabled boolean; v_cap int; v_depth int; v_missing int;
BEGIN
  SELECT is_enabled, max_queue_depth INTO v_enabled, v_cap FROM public.social_file_settings WHERE id;
  IF NOT COALESCE(v_enabled, false) THEN RETURN NULL; END IF;
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
END $$;
REVOKE ALL ON FUNCTION public.social_file_enqueue(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_file_enqueue(uuid, text) TO service_role;

-- a post gets (or changes) its project → register its media
CREATE OR REPLACE FUNCTION public.tg_mkt_enrichment_enqueue_social_file()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF NEW.status = 'done' AND NEW.primary_project_id IS NOT NULL THEN
    PERFORM public.social_file_enqueue(NEW.content_post_id, 'attribution');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS mkt_enrichment_enqueue_social_file ON public.mkt_content_enrichment;
CREATE TRIGGER mkt_enrichment_enqueue_social_file
  AFTER INSERT OR UPDATE OF primary_project_id, status ON public.mkt_content_enrichment
  FOR EACH ROW EXECUTE FUNCTION public.tg_mkt_enrichment_enqueue_social_file();

-- media stored after the project was already decided → register it
CREATE OR REPLACE FUNCTION public.tg_mkt_media_enqueue_social_file()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
BEGIN
  IF NEW.download_status = 'stored' AND NEW.file_id IS NULL AND NEW.media_kind IN ('image','video') THEN
    PERFORM public.social_file_enqueue(NEW.content_post_id, 'media_stored');
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS mkt_media_enqueue_social_file ON public.mkt_content_media;
CREATE TRIGGER mkt_media_enqueue_social_file
  AFTER INSERT OR UPDATE OF download_status ON public.mkt_content_media
  FOR EACH ROW EXECUTE FUNCTION public.tg_mkt_media_enqueue_social_file();

-- the sweep / operator backfill: newest posts first, bounded by the cap
CREATE OR REPLACE FUNCTION public.social_file_backfill(p_limit int DEFAULT 50)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE r record; n int := 0; j uuid;
BEGIN
  FOR r IN
    SELECT DISTINCT p.id, p.published_at
      FROM public.mkt_content_posts p
      JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done' AND e.primary_project_id IS NOT NULL
      JOIN public.mkt_content_media m ON m.content_post_id = p.id AND m.download_status = 'stored'
       AND m.stored_path IS NOT NULL AND m.media_kind IN ('image','video') AND m.file_id IS NULL
     WHERE NOT EXISTS (SELECT 1 FROM public.generation_jobs g WHERE g.record_id = p.id AND g.kind = 'social-file' AND g.status IN ('queued','running'))
     ORDER BY p.published_at DESC NULLS LAST
     LIMIT GREATEST(0, p_limit)
  LOOP
    j := public.social_file_enqueue(r.id, 'backfill');
    IF j IS NOT NULL THEN n := n + 1; ELSE EXIT; END IF;  -- cap reached or disabled
  END LOOP;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.social_file_backfill(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.social_file_backfill(int) TO service_role;

-- ── 7. Library: how many of the post's media are in Files ───────────────────
CREATE OR REPLACE FUNCTION public.mkt_content_library(
  p_shelf     text    DEFAULT NULL,
  p_org       uuid    DEFAULT NULL,
  p_format    text    DEFAULT NULL,
  p_platform  text    DEFAULT NULL,
  p_has_offer boolean DEFAULT NULL,
  p_q         text    DEFAULT NULL,
  p_limit     int     DEFAULT 40,
  p_offset    int     DEFAULT 0
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
WITH base AS (
  SELECT
    p.id, p.platform, p.post_type, p.caption, p.engagement, p.published_at,
    p.post_url, p.duration_ms, p.organization_id,
    o.name_ar                                   AS org_name,
    o.developer_record_id                       AS developer_record_id,
    e.primary_project_id,
    e.attribution_locked_at,
    e.candidate_projects,
    e.result                                    AS r,
    (e.result->>'content_type')                 AS content_type
  FROM public.mkt_content_posts p
  JOIN public.mkt_organizations o        ON o.id = p.organization_id
  JOIN public.mkt_content_enrichment e   ON e.content_post_id = p.id AND e.status = 'done'
),
filt AS (
  SELECT * FROM base
  WHERE (p_org      IS NULL OR organization_id = p_org)
    AND (p_format   IS NULL OR post_type = p_format)
    AND (p_platform IS NULL OR platform = p_platform)
    AND (p_has_offer IS NULL OR (p_has_offer = ((COALESCE(r->>'offer','') <> '') OR content_type = 'offer')))
    AND (p_q IS NULL OR p_q = '' OR (
          caption               ILIKE '%'||p_q||'%'
       OR (r->>'campaign_message') ILIKE '%'||p_q||'%'
       OR (r->>'objective')        ILIKE '%'||p_q||'%'
    ))
),
shelved AS (
  SELECT * FROM filt WHERE (p_shelf IS NULL OR content_type = p_shelf)
),
page AS (
  SELECT jsonb_agg(to_jsonb(x)) AS rows FROM (
    SELECT
      s.id, s.org_name, s.organization_id, s.developer_record_id, s.platform,
      s.primary_project_id::text                      AS project_record_id,
      (s.attribution_locked_at IS NOT NULL)           AS attribution_locked,
      (SELECT c->>'strength' FROM jsonb_array_elements(s.candidate_projects) c
        WHERE c->>'projectId' = s.primary_project_id::text LIMIT 1) AS attribution_strength,
      COALESCE(s.r->'mentioned_projects', '[]'::jsonb) AS unknown_projects,
      COALESCE((s.r->>'is_general_branding')::boolean, false) AS is_general_branding,
      (SELECT count(*) FROM public.mkt_content_media m WHERE m.content_post_id = s.id AND m.file_id IS NOT NULL) AS files_registered,
      s.post_type                                     AS format,
      s.content_type                                  AS shelf,
      COALESCE(NULLIF(s.r->>'campaign_message',''), LEFT(s.caption, 180)) AS summary,
      LEFT(s.caption, 500)                            AS caption,
      (s.r->'selling_points')                         AS selling_points,
      (s.r->'unit_types')                             AS unit_types,
      (s.r->'amenities')                              AS amenities,
      (s.r->'ctas')                                   AS ctas,
      NULLIF(s.r->>'offer','')                        AS offer,
      NULLIF(s.r->>'price','')                        AS price,
      NULLIF(s.r->>'payment_plan','')                 AS payment_plan,
      NULLIF(s.r->>'district','')                     AS district,
      s.engagement, s.published_at, s.post_url,
      (s.duration_ms IS NOT NULL AND s.duration_ms > 0) AS is_video,
      EXISTS (SELECT 1 FROM public.mkt_transcripts t
               WHERE t.content_post_id = s.id AND t.status = 'done') AS has_transcript,
      (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name', ur.data->>'title')
         FROM public.unified_records ur
        WHERE ur.id = s.primary_project_id)          AS project_name,
      (SELECT m.stored_url FROM public.mkt_content_media m
         WHERE m.content_post_id = s.id AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
         ORDER BY (m.media_kind = 'thumbnail') DESC, (m.media_kind = 'image') DESC, m.created_at
         LIMIT 1)                                     AS thumb_url,
      (SELECT jsonb_agg(jsonb_build_object('kind', m.media_kind, 'url', m.stored_url) ORDER BY m.created_at)
         FROM public.mkt_content_media m
        WHERE m.content_post_id = s.id AND m.download_status = 'stored'
          AND m.stored_url IS NOT NULL
          AND m.media_kind IN ('image', 'video')) AS media
    FROM shelved s
    ORDER BY s.published_at DESC NULLS LAST, s.id
    LIMIT GREATEST(p_limit, 0) OFFSET GREATEST(p_offset, 0)
  ) x
),
shelves AS (
  SELECT jsonb_object_agg(content_type, c) AS obj FROM (
    SELECT COALESCE(content_type, 'unknown') AS content_type, count(*) AS c
    FROM filt GROUP BY 1
  ) f
)
SELECT jsonb_build_object(
  'total',   (SELECT count(*) FROM shelved),
  'shelves', COALESCE((SELECT obj FROM shelves), '{}'::jsonb),
  'rows',    COALESCE((SELECT rows FROM page), '[]'::jsonb)
);
$$;

COMMIT;
