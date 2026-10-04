-- Cross-posts (2026-10-04): the same post published by one company on two or
-- three platforms is linked to its original, so the Content Library shows it
-- once (with «also on TikTok» and that copy's own numbers) and Market Watch
-- counts it once.
--
-- Measured before this migration: 406 cross-platform pairs in the last 12
-- months covering 753 posts (13% of 5,766) — 394 Instagram+TikTok, 11
-- Instagram+YouTube, 1 TikTok+YouTube — almost all published within the same
-- hour with an identical caption.
--
-- The rule (deliberately strict — a missed link only shows a post twice, a
-- false link would hide a real post): same company, different platform,
-- identical normalised caption of at least 25 characters (hashtags, mentions,
-- links and punctuation removed; first 120 characters), published within 3
-- days. The original is the earliest copy (ties: platform name order).
--
-- Nothing is deleted and nothing is re-read: every copy keeps its own row,
-- media, numbers and reading; `repost_of` only says which one to show.

BEGIN;

ALTER TABLE public.mkt_content_posts
  ADD COLUMN IF NOT EXISTS repost_of uuid REFERENCES public.mkt_content_posts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS mkt_content_posts_repost_of_idx
  ON public.mkt_content_posts (repost_of) WHERE repost_of IS NOT NULL;

CREATE OR REPLACE FUNCTION public.mkt_repost_key(p_caption text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(k) >= 25 THEN k END
    FROM (SELECT left(public.mkt_norm_phrase(
                   regexp_replace(coalesce(p_caption, ''), '[#@]\S+|https?://\S+|[^\w\s]', '', 'g')), 120) AS k) s
$$;

CREATE INDEX IF NOT EXISTS mkt_content_posts_repost_key_idx
  ON public.mkt_content_posts (organization_id, public.mkt_repost_key(caption))
  WHERE public.mkt_repost_key(caption) IS NOT NULL;

-- Re-derive the links for one company + caption group. Idempotent: rows whose
-- link is already right are not touched.
CREATE OR REPLACE FUNCTION public.mkt_relink_reposts(p_org uuid, p_key text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE n integer := 0;
BEGIN
  IF p_org IS NULL OR p_key IS NULL THEN RETURN 0; END IF;
  WITH g AS (
    SELECT id, platform, published_at FROM public.mkt_content_posts
     WHERE organization_id = p_org AND public.mkt_repost_key(caption) = p_key AND published_at IS NOT NULL
  ), pick AS (
    SELECT a.id,
           (SELECT b.id FROM g b
             WHERE b.platform <> a.platform
               AND b.published_at >= a.published_at - interval '3 days'
               AND (b.published_at, b.platform) < (a.published_at, a.platform)
             ORDER BY b.published_at, b.platform LIMIT 1) AS orig
      FROM g a
  )
  UPDATE public.mkt_content_posts p SET repost_of = pick.orig
    FROM pick
   WHERE p.id = pick.id AND p.repost_of IS DISTINCT FROM pick.orig;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.mkt_relink_reposts(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_relink_reposts(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.mkt_content_posts_repost_trg()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM public.mkt_relink_reposts(NEW.organization_id, public.mkt_repost_key(NEW.caption));
  IF TG_OP = 'UPDATE' AND (OLD.organization_id IS DISTINCT FROM NEW.organization_id
                           OR public.mkt_repost_key(OLD.caption) IS DISTINCT FROM public.mkt_repost_key(NEW.caption)) THEN
    PERFORM public.mkt_relink_reposts(OLD.organization_id, public.mkt_repost_key(OLD.caption));
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- Linking is display bookkeeping; collection must never lose a post over it.
  -- Loud in the Postgres log, and the next write to the group relinks it.
  RAISE WARNING 'mkt_content_posts_repost_trg failed for post %: % (%)', NEW.id, SQLERRM, SQLSTATE;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS mkt_content_posts_repost ON public.mkt_content_posts;
-- UPDATE OF lists only the inputs to the rule: the relink's own UPDATE of
-- repost_of does not re-fire it.
CREATE TRIGGER mkt_content_posts_repost
  AFTER INSERT OR UPDATE OF caption, published_at, organization_id ON public.mkt_content_posts
  FOR EACH ROW EXECUTE FUNCTION public.mkt_content_posts_repost_trg();

-- Backfill every existing group.
DO $bf$
DECLARE r record; total integer := 0;
BEGIN
  FOR r IN SELECT DISTINCT organization_id AS org, public.mkt_repost_key(caption) AS k
             FROM public.mkt_content_posts WHERE public.mkt_repost_key(caption) IS NOT NULL LOOP
    total := total + public.mkt_relink_reposts(r.org, r.k);
  END LOOP;
  RAISE NOTICE 'reposts linked: %', total;
END $bf$;

CREATE OR REPLACE FUNCTION public.mkt_content_library(
  p_shelf text DEFAULT NULL, p_org uuid DEFAULT NULL, p_format text DEFAULT NULL, p_platform text DEFAULT NULL,
  p_has_offer boolean DEFAULT NULL, p_q text DEFAULT NULL, p_limit integer DEFAULT 40, p_offset integer DEFAULT 0,
  p_sort text DEFAULT 'recent')
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH baseline AS MATERIALIZED (
  -- Computed ONCE. A plain join to the view let the planner re-run its median
  -- aggregate for every post: 3,838 posts took over 120 s on 2026-10-04.
  SELECT * FROM public.mkt_account_baseline_v
),
base AS (
  SELECT
    p.id, p.platform, p.post_type, p.caption, p.engagement, p.published_at,
    p.post_url, p.duration_ms, p.organization_id, p.social_account_id, p.repost_of,
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
    -- a cross-post is shown once, on its original; filtering by platform shows each platform's copy
    AND (p_platform IS NOT NULL OR repost_of IS NULL)
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
  SELECT f.*,
         public.try_numeric(f.engagement->>'views') AS v_views,
         public.try_numeric(f.engagement->>'likes') AS v_likes,
         b.median_views, b.median_likes,
         CASE WHEN public.try_numeric(f.engagement->>'views') > 0 AND b.median_views >= 50
                THEN public.try_numeric(f.engagement->>'views') / b.median_views
              WHEN public.try_numeric(f.engagement->>'likes') > 0 AND b.median_likes >= 5
                THEN public.try_numeric(f.engagement->>'likes') / b.median_likes END AS vs_usual
    FROM filt f
    LEFT JOIN baseline b ON b.social_account_id = f.social_account_id
   WHERE (p_shelf IS NULL OR f.content_type = p_shelf)
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
          AND m.media_kind IN ('image', 'video')) AS media,
      -- performance (2026-10-04)
      s.v_views AS views, s.v_likes AS likes,
      public.try_numeric(s.engagement->>'comments') AS comments,
      public.try_numeric(s.engagement->>'shares')   AS shares,
      public.try_numeric(s.engagement->>'saves')    AS saves,
      public.mkt_post_age_reading(s.id, s.published_at, 7)  AS at_7d,
      public.mkt_post_age_reading(s.id, s.published_at, 30) AS at_30d,
      round(s.median_views) AS usual_views, round(s.median_likes) AS usual_likes,
      round(s.vs_usual, 1)  AS vs_usual,
      -- A guess, labelled as one in the UI: views far above the account's usual
      -- with almost no likes is the shape of a paid ad (measured: YouTube videos
      -- at 1.6-5.8 M views with 1-24 likes on channels that usually get 119-509).
      (s.v_views >= 20 * s.median_views AND s.median_views >= 50
        AND COALESCE(s.v_likes, 0) < 0.002 * s.v_views)  AS likely_paid,
      (SELECT sa.handle FROM public.mkt_social_accounts sa WHERE sa.id = s.social_account_id) AS account_handle,
      -- one library (2026-10-04): the post's stored video and its shot status,
      -- so a video entry can open its shots in place
      vm.id AS video_media_id,
      (SELECT v.status FROM public.mkt_cv_videos v WHERE v.content_media_id = vm.id) AS shots_status,
      (SELECT v.shot_count FROM public.mkt_cv_videos v WHERE v.content_media_id = vm.id) AS shot_count,
      -- the same post on other platforms (2026-10-04_07), with that copy's own numbers
      (SELECT jsonb_agg(jsonb_build_object('id', c.id, 'platform', c.platform, 'url', c.post_url,
                 'views', public.try_numeric(c.engagement->>'views'), 'likes', public.try_numeric(c.engagement->>'likes'))
                 ORDER BY c.platform)
         FROM public.mkt_content_posts c WHERE c.repost_of = s.id) AS also_on
    FROM shelved s
    LEFT JOIN LATERAL (SELECT m.id FROM public.mkt_content_media m
                        WHERE m.content_post_id = s.id AND m.media_kind = 'video' AND m.download_status = 'stored'
                        ORDER BY m.carousel_index LIMIT 1) vm ON true
    ORDER BY
      CASE WHEN p_sort = 'views'    THEN s.v_views  END DESC NULLS LAST,
      CASE WHEN p_sort = 'likes'    THEN s.v_likes  END DESC NULLS LAST,
      CASE WHEN p_sort = 'vs_usual' THEN s.vs_usual END DESC NULLS LAST,
      s.published_at DESC NULLS LAST, s.id
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
$function$;
-- Same grants the previous version had (captured 2026-10-04).
REVOKE ALL ON FUNCTION public.mkt_content_library(text, uuid, text, text, boolean, text, integer, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_content_library(text, uuid, text, text, boolean, text, integer, integer, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mkt_market_watch(p_days int DEFAULT 30, p_kinds text[] DEFAULT NULL, p_org uuid DEFAULT NULL, p_limit int DEFAULT 200)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
WITH posts AS (
  SELECT p.id, p.organization_id AS org_id, o.name_ar AS org_name, p.platform, p.post_type, p.published_at, p.post_url,
         e.primary_project_id AS project_id, e.result AS r, (e.result->>'content_type') AS content_type,
         coalesce(p.caption, '') AS caption
    FROM public.mkt_content_posts p
    JOIN public.mkt_organizations o ON o.id = p.organization_id
    JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done'
   WHERE p.published_at IS NOT NULL AND (p_org IS NULL OR p.organization_id = p_org)
     AND p.repost_of IS NULL  -- a cross-post is one piece of news, not two
),
win AS (SELECT now() - make_interval(days => GREATEST(p_days, 1)) AS since),
pname AS (
  SELECT ur.id, COALESCE(ur.data->>'project_name', ur.data->>'name') AS name FROM public.unified_records ur
   WHERE ur.id IN (SELECT DISTINCT project_id FROM posts WHERE project_id IS NOT NULL)
),
-- catalog project, first post by ANYONE (not limited by p_org: "new to the market")
first_catalog AS (
  SELECT DISTINCT ON (e.primary_project_id) e.primary_project_id AS project_id, p.id AS post_id, p.published_at, p.organization_id
    FROM public.mkt_content_posts p JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done'
   WHERE e.primary_project_id IS NOT NULL AND p.published_at IS NOT NULL AND p.repost_of IS NULL
   ORDER BY e.primary_project_id, p.published_at
),
unknown_mentions AS (
  SELECT public.mkt_norm_phrase(x) AS key, btrim(x) AS name, p.*
    FROM posts p, jsonb_array_elements_text(COALESCE(p.r->'mentioned_projects', '[]'::jsonb)) x
   WHERE btrim(x) <> ''
),
ev_new_project AS (
  SELECT 'new_project'::text AS kind, f.published_at AS at, f.organization_id AS org_id, f.project_id,
         NULL::text AS name, jsonb_build_object('in_catalog', true) AS detail, ARRAY[f.post_id] AS post_ids
    FROM first_catalog f WHERE (p_org IS NULL OR f.organization_id = p_org)
  UNION ALL
  SELECT 'new_project', min(m.published_at), (array_agg(m.org_id ORDER BY m.published_at))[1], NULL,
         (array_agg(m.name ORDER BY m.published_at))[1], jsonb_build_object('in_catalog', false, 'companies', count(DISTINCT m.org_id)),
         (array_agg(m.id ORDER BY m.published_at))[1:5]
    FROM unknown_mentions m GROUP BY m.key
),
ev_launch AS (
  -- one item per company + project; a project we do not have yet is grouped by
  -- its name, so two launch posts for «EWAN LIVING» are one launch
  SELECT 'launch'::text, min(published_at), org_id, project_id,
         CASE WHEN project_id IS NULL THEN (array_agg(NULLIF(r->'mentioned_projects'->>0, '') ORDER BY published_at))[1] END,
         jsonb_build_object('posts', count(*)), (array_agg(id ORDER BY published_at))[1:5]
    FROM posts p, win WHERE content_type = 'project_launch' AND published_at >= win.since
   GROUP BY org_id, project_id,
            CASE WHEN project_id IS NULL THEN COALESCE(public.mkt_norm_phrase(NULLIF(r->'mentioned_projects'->>0, '')), p.id::text) END
),
offers AS (
  SELECT p.*, public.mkt_norm_phrase(r->>'offer') AS okey FROM posts p WHERE COALESCE(r->>'offer', '') <> ''
),
ev_offer AS (
  SELECT 'offer'::text, min(published_at), org_id, project_id, NULL::text,
         jsonb_build_object('offer', (array_agg(r->>'offer' ORDER BY published_at))[1], 'price', (array_agg(NULLIF(r->>'price','') ORDER BY published_at))[1],
                            'payment_plan', (array_agg(NULLIF(r->>'payment_plan','') ORDER BY published_at))[1], 'posts', count(*)),
         (array_agg(id ORDER BY published_at))[1:5]
    FROM offers GROUP BY org_id, project_id, okey
),
prices AS (
  SELECT p.*, public.mkt_price_number(r->>'price') AS amount,
         lag(public.mkt_price_number(r->>'price')) OVER w AS prev_amount, lag(r->>'price') OVER w AS prev_price
    FROM posts p WHERE public.mkt_price_number(r->>'price') > 1000 AND project_id IS NOT NULL
  WINDOW w AS (PARTITION BY org_id, project_id ORDER BY published_at)
),
ev_price AS (
  -- the AMOUNT moved by more than 1% (wording alone never counts)
  SELECT 'price'::text, published_at, org_id, project_id, NULL::text,
         jsonb_build_object('price', r->>'price', 'previous', prev_price, 'amount', amount, 'previous_amount', prev_amount,
                            'change_pct', round((amount - prev_amount) / prev_amount * 100, 1)), ARRAY[id]
    FROM prices WHERE prev_amount IS NOT NULL AND abs(amount - prev_amount) > 0.01 * prev_amount
),
ev_event AS (
  SELECT 'event'::text, min(published_at), org_id, project_id, NULL::text,
         jsonb_build_object('message', (array_agg(NULLIF(r->>'campaign_message','') ORDER BY published_at))[1], 'posts', count(*)),
         (array_agg(id ORDER BY published_at))[1:5]
    FROM posts WHERE content_type = 'event' AND COALESCE((r->>'is_general_branding')::boolean, false) = false
   GROUP BY org_id, project_id, date_trunc('day', published_at)
),
sold AS (
  SELECT p.* FROM posts p
   WHERE (p.caption || ' ' || COALESCE((SELECT string_agg(v.text, ' ') FROM public.mkt_visual_text v WHERE v.content_post_id = p.id), '')
          || ' ' || COALESCE((SELECT string_agg(t.text, ' ') FROM public.mkt_transcripts t WHERE t.content_post_id = p.id AND t.status = 'done'), ''))
         ~* '(تم البيع بالكامل|بيعت بالكامل|بيع كامل|تم بيع جميع|تم بيع كامل|نفدت الوحدات|نفذت الوحدات|اكتمل البيع|sold[ -]?out|fully sold)'
),
ev_sold AS (
  SELECT 'sold_out'::text, min(published_at), org_id, project_id, NULL::text,
         jsonb_build_object('posts', count(*)), (array_agg(id ORDER BY published_at))[1:5]
    FROM sold GROUP BY org_id, project_id, CASE WHEN project_id IS NULL THEN id END
),
all_ev AS (
  SELECT * FROM ev_new_project UNION ALL SELECT * FROM ev_launch UNION ALL SELECT * FROM ev_offer
  UNION ALL SELECT * FROM ev_price UNION ALL SELECT * FROM ev_event UNION ALL SELECT * FROM ev_sold
),
picked AS (
  SELECT a.* FROM all_ev a, win
   WHERE a.at >= win.since AND (p_kinds IS NULL OR a.kind = ANY(p_kinds))
)
SELECT jsonb_build_object(
  'counts', COALESCE((SELECT jsonb_object_agg(kind, n) FROM (SELECT a.kind, count(*) n FROM all_ev a, win WHERE a.at >= win.since GROUP BY 1) c), '{}'::jsonb),
  'items', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'kind', x.kind, 'at', x.at, 'organization_id', x.org_id,
      'org_name', (SELECT o.name_ar FROM public.mkt_organizations o WHERE o.id = x.org_id),
      'project_id', x.project_id, 'project_name', COALESCE((SELECT n.name FROM pname n WHERE n.id = x.project_id),
                                                            (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name') FROM public.unified_records ur WHERE ur.id = x.project_id)),
      'name', NULLIF(x.name, ''), 'detail', x.detail,
      'posts', (SELECT jsonb_agg(jsonb_build_object('id', p.id, 'url', p.post_url, 'platform', p.platform, 'at', p.published_at,
                  'thumb', (SELECT m.stored_url FROM public.mkt_content_media m WHERE m.content_post_id = p.id AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
                             ORDER BY (m.media_kind = 'thumbnail') DESC, (m.media_kind = 'image') DESC, m.created_at LIMIT 1))
                  ORDER BY p.published_at)
                  FROM public.mkt_content_posts p WHERE p.id = ANY(x.post_ids))
    ) ORDER BY x.at DESC)
    FROM (SELECT * FROM picked ORDER BY at DESC LIMIT GREATEST(LEAST(p_limit, 500), 1)) x
  ), '[]'::jsonb)
);
$function$;

REVOKE ALL ON FUNCTION public.mkt_market_watch(int, text[], uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_market_watch(int, text[], uuid, int) TO service_role;

COMMIT;
