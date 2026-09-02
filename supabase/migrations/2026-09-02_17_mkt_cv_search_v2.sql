-- Visual search follow-ups from the UI integration: platform filter, browse mode
-- (empty query → newest shots), neighbour ids, attributed frame-mode rows, and a
-- `paused` key on health. All CREATE OR REPLACE; no table changes.

CREATE OR REPLACE FUNCTION public.mkt_cv_search(
  p_qvec_image extensions.vector(768), p_qvec_text extensions.vector(1024), p_query_text text,
  p_filters jsonb DEFAULT '{}'::jsonb, p_mode text DEFAULT 'shot', p_limit int DEFAULT 60)
RETURNS TABLE (
  shot_id uuid, video_id uuid, frame_id uuid, content_media_id uuid, content_post_id uuid, organization_id uuid, org_name text,
  owner text, platform text, published_at timestamptz, post_url text, stored_url text, start_ms int, end_ms int, duration_ms int,
  representative_frame_url text, summary text, tags text[], score numeric, why jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
  WITH base AS (
    SELECT s.*, v.content_media_id AS cmid, v.content_post_id AS cpid, v.organization_id AS org, v.owner AS vowner, v.source_url,
           p.platform AS pplatform, p.published_at AS ppublished, p.post_url AS ppost_url
      FROM public.mkt_cv_shots s JOIN public.mkt_cv_videos v ON v.id = s.video_id
      LEFT JOIN public.mkt_content_posts p ON p.id = v.content_post_id
     WHERE v.status IN ('frames_done','analyzing','analyzed','partial')
       AND (COALESCE((p_filters->>'exclude_micro')::boolean, true) = false OR NOT s.is_micro)
       AND (p_filters->>'organization_id' IS NULL OR v.organization_id = (p_filters->>'organization_id')::uuid)
       AND (p_filters->>'owner' IS NULL OR v.owner = p_filters->>'owner')
       AND (p_filters->>'platform' IS NULL OR p.platform = p_filters->>'platform')
       AND (p_filters->>'min_duration_ms' IS NULL OR s.duration_ms >= (p_filters->>'min_duration_ms')::int)
       AND (p_filters->>'max_duration_ms' IS NULL OR s.duration_ms <= (p_filters->>'max_duration_ms')::int)
       AND (NOT (p_filters ? 'tags') OR s.tags @> (SELECT array_agg(x) FROM jsonb_array_elements_text(p_filters->'tags') x))
  ),
  vis AS (SELECT id, row_number() OVER (ORDER BY embedding_visual <=> p_qvec_image) AS rk, 1 - (embedding_visual <=> p_qvec_image) AS sim
            FROM base WHERE p_qvec_image IS NOT NULL AND embedding_visual IS NOT NULL ORDER BY embedding_visual <=> p_qvec_image LIMIT 200),
  txt AS (SELECT id, row_number() OVER (ORDER BY embedding_text <=> p_qvec_text) AS rk, 1 - (embedding_text <=> p_qvec_text) AS sim
            FROM base WHERE p_qvec_text IS NOT NULL AND embedding_text IS NOT NULL ORDER BY embedding_text <=> p_qvec_text LIMIT 200),
  lex AS (SELECT id, row_number() OVER (ORDER BY ts_rank(search_tsv, plainto_tsquery('simple', p_query_text)) DESC) AS rk,
                 ts_rank(search_tsv, plainto_tsquery('simple', p_query_text)) AS sim
            FROM base WHERE COALESCE(p_query_text,'') <> '' AND search_tsv @@ plainto_tsquery('simple', p_query_text) LIMIT 200),
  -- browse mode: no query vectors and no text → newest shots (one per video ordering handled by the API)
  browse AS (SELECT id, row_number() OVER (ORDER BY ppublished DESC NULLS LAST, start_ms) AS rk, 0::double precision AS sim
               FROM base WHERE p_qvec_image IS NULL AND p_qvec_text IS NULL AND COALESCE(p_query_text,'') = '' LIMIT 200),
  fused AS (
    SELECT id, sum(1.0 / (60 + rk)) AS score,
           jsonb_build_object('visual', max(CASE WHEN ch='vis' THEN sim END), 'text', max(CASE WHEN ch='txt' THEN sim END),
                              'lexical', max(CASE WHEN ch='lex' THEN sim END), 'browse', bool_or(ch='browse')) AS why
      FROM (SELECT id, rk, sim, 'vis' AS ch FROM vis UNION ALL SELECT id, rk, sim, 'txt' FROM txt
            UNION ALL SELECT id, rk, sim, 'lex' FROM lex UNION ALL SELECT id, rk, sim, 'browse' FROM browse) u
     GROUP BY id)
  SELECT b.id, b.video_id, b.representative_frame_id, b.cmid, b.cpid, b.org, o.name_ar, b.vowner, b.pplatform, b.ppublished, b.ppost_url,
         b.source_url, b.start_ms, b.end_ms, b.duration_ms, f.public_url, b.summary, b.tags, fused.score::numeric, fused.why
    FROM fused JOIN base b ON b.id = fused.id
    LEFT JOIN public.mkt_cv_frames f ON f.id = b.representative_frame_id
    LEFT JOIN public.mkt_organizations o ON o.id = b.org
   ORDER BY fused.score DESC LIMIT GREATEST(p_limit, 1);
$$;

DROP FUNCTION IF EXISTS public.mkt_cv_search_frames(extensions.vector, text, jsonb, int);
CREATE OR REPLACE FUNCTION public.mkt_cv_search_frames(p_qvec_image extensions.vector(768), p_query_text text, p_filters jsonb DEFAULT '{}'::jsonb, p_limit int DEFAULT 60)
RETURNS TABLE (frame_id uuid, shot_id uuid, video_id uuid, ts_ms int, public_url text, labels text[], ocr_text text, score numeric,
               organization_id uuid, org_name text, platform text, published_at timestamptz, post_url text, stored_url text, shot_start_ms int, shot_end_ms int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','extensions' AS $$
  SELECT f.id, f.shot_id, f.video_id, f.ts_ms, f.public_url, f.labels, f.ocr->>'text',
         ((CASE WHEN p_qvec_image IS NOT NULL AND f.embedding IS NOT NULL THEN 1 - (f.embedding <=> p_qvec_image) ELSE 0 END)
          + (CASE WHEN COALESCE(p_query_text,'') <> '' AND COALESCE(f.ocr->>'text','') ILIKE '%' || p_query_text || '%' THEN 0.5 ELSE 0 END))::numeric AS score,
         v.organization_id, o.name_ar, p.platform, p.published_at, p.post_url, v.source_url, s.start_ms, s.end_ms
    FROM public.mkt_cv_frames f JOIN public.mkt_cv_videos v ON v.id = f.video_id
    LEFT JOIN public.mkt_cv_shots s ON s.id = f.shot_id
    LEFT JOIN public.mkt_content_posts p ON p.id = v.content_post_id
    LEFT JOIN public.mkt_organizations o ON o.id = v.organization_id
   WHERE (p_filters->>'owner' IS NULL OR v.owner = p_filters->>'owner')
     AND (p_filters->>'organization_id' IS NULL OR v.organization_id = (p_filters->>'organization_id')::uuid)
     AND (p_filters->>'platform' IS NULL OR p.platform = p_filters->>'platform')
     AND (f.dup_group_id IS NULL OR f.id = (SELECT representative_frame_id FROM public.mkt_cv_dup_groups d WHERE d.id = f.dup_group_id))
   ORDER BY score DESC LIMIT GREATEST(p_limit, 1);
$$;

CREATE OR REPLACE FUNCTION public.mkt_cv_shot(p_shot_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'shot', to_jsonb(s) - 'embedding_visual' - 'embedding_text' - 'search_tsv',
    'video', jsonb_build_object('id', v.id, 'content_media_id', v.content_media_id, 'content_post_id', v.content_post_id,
                                'organization_id', v.organization_id, 'org_name', o.name_ar, 'owner', v.owner, 'source_url', v.source_url,
                                'duration_ms', v.duration_ms, 'status', v.status, 'structure', v.structure),
    'post', (SELECT jsonb_build_object('platform', p.platform, 'post_url', p.post_url, 'published_at', p.published_at, 'caption', LEFT(p.caption, 300))
               FROM public.mkt_content_posts p WHERE p.id = v.content_post_id),
    'frames', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', f.id, 'ts_ms', f.ts_ms, 'public_url', f.public_url, 'is_keyframe', f.is_keyframe,
                 'is_boundary', f.is_boundary, 'labels', f.labels, 'ocr_text', f.ocr->>'text', 'has_analysis', f.analysis IS NOT NULL, 'dup_group_id', f.dup_group_id) ORDER BY f.ts_ms), '[]'::jsonb)
                 FROM public.mkt_cv_frames f WHERE f.shot_id = s.id),
    'neighbours', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', n.id, 'shot_no', n.shot_no, 'summary', n.summary, 'start_ms', n.start_ms, 'end_ms', n.end_ms) ORDER BY n.shot_no), '[]'::jsonb)
                     FROM public.mkt_cv_shots n WHERE n.video_id = s.video_id AND abs(n.shot_no - s.shot_no) = 1))
    FROM public.mkt_cv_shots s JOIN public.mkt_cv_videos v ON v.id = s.video_id LEFT JOIN public.mkt_organizations o ON o.id = v.organization_id
   WHERE s.id = p_shot_id;
$$;

CREATE OR REPLACE FUNCTION public.mkt_cv_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT jsonb_build_object(
    'enabled', public.mkt_cv_enabled(),
    'paused', (NOT public.mkt_cv_enabled()) OR (NOT public.mkt_cv_budget_ok()),
    'videos', (SELECT COALESCE(jsonb_object_agg(status, n), '{}'::jsonb) FROM (SELECT status, count(*) n FROM public.mkt_cv_videos GROUP BY status) x),
    'shots', (SELECT COALESCE(jsonb_object_agg(analysis_status, n), '{}'::jsonb) FROM (SELECT analysis_status, count(*) n FROM public.mkt_cv_shots GROUP BY analysis_status) x),
    'frames', (SELECT count(*) FROM public.mkt_cv_frames),
    'keyframes_described', (SELECT count(*) FROM public.mkt_cv_frames WHERE analysis IS NOT NULL),
    'jobs', (SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb) FROM (SELECT kind || ':' || status AS k, count(*) n FROM public.mkt_cv_jobs GROUP BY kind, status) x),
    'oldest_running_s', (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(started_at)))::int, 0) FROM public.mkt_cv_jobs WHERE status = 'running'),
    'cost_today_usd', public.mkt_cv_cost_today(),
    'cost_month_usd', (SELECT COALESCE(sum(cost_usd),0) FROM public.mkt_cv_cost_ledger WHERE created_at >= date_trunc('month', now())),
    'budget_usd', COALESCE((SELECT (value)::numeric FROM public.mkt_settings WHERE key='cv.daily_budget_usd'), 30),
    'budget_ok', public.mkt_cv_budget_ok());
$$;

DO $$ DECLARE f record; BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname IN ('mkt_cv_search','mkt_cv_search_frames','mkt_cv_shot','mkt_cv_health') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.sig);
  END LOOP;
END $$;
