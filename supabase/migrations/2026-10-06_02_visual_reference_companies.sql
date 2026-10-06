-- 2026-10-06: «مرجع بصري» — companies followed ONLY for how their posts look
-- (car brands, entertainment, …), never for what they say.
--
-- New company type org_type = 'visual_reference'. Their posts are collected
-- like any account (same Apify / YouTube lanes), their media stored, their
-- videos offered to shots and their image posts design-read — but the worker
-- never runs the project reader on them (runContentProcess.isVisualReferenceOrg),
-- so they get no enrichment row, no project match and no transcription.
--
-- Because most competitor views require a read (enrichment) they already
-- exclude these posts; the ones that do not are fenced explicitly here:
--   mkt_compute_share_of_voice, mkt_generate_trend_insights,
--   mkt_script_exemplars, mkt_post_copy_examples (writing is never learned).
-- They stay IN the places that are about visuals: mkt_creative_references
-- (unchanged — it already admits any non-internal company), the shot library
-- and the design reads. mkt_content_library shows them only on their own
-- company page or the new «visual_reference» shelf; mkt_design_read_due offers
-- their image posts for a design read without needing a content read.
-- CREATE OR REPLACE FUNCTION keeps each function's owner and grants.
BEGIN;

ALTER TABLE public.mkt_organizations DROP CONSTRAINT IF EXISTS mkt_organizations_org_type_check;
ALTER TABLE public.mkt_organizations ADD CONSTRAINT mkt_organizations_org_type_check
  CHECK (org_type IN ('developer','marketer','agency','influencer','internal','publisher','visual_reference'));

CREATE OR REPLACE FUNCTION public.mkt_content_library(p_shelf text DEFAULT NULL::text, p_org uuid DEFAULT NULL::uuid, p_format text DEFAULT NULL::text, p_platform text DEFAULT NULL::text, p_has_offer boolean DEFAULT NULL::boolean, p_q text DEFAULT NULL::text, p_limit integer DEFAULT 40, p_offset integer DEFAULT 0, p_sort text DEFAULT 'recent'::text)
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
  -- Read competitor posts (the usual Library) …
  SELECT
    p.id, p.platform, p.post_type, p.caption, p.engagement, p.published_at,
    p.post_url, p.duration_ms, p.organization_id, p.social_account_id, p.repost_of,
    o.name_ar                                   AS org_name,
    o.developer_record_id                       AS developer_record_id,
    o.org_type                                  AS org_type,
    e.primary_project_id,
    e.attribution_locked_at,
    e.candidate_projects,
    e.result                                    AS r,
    (e.result->>'content_type')                 AS content_type
  FROM public.mkt_content_posts p
  JOIN public.mkt_organizations o        ON o.id = p.organization_id
  JOIN public.mkt_content_enrichment e   ON e.content_post_id = p.id AND e.status = 'done'
  WHERE p_shelf IS DISTINCT FROM 'visual_reference'
  UNION ALL
  -- … plus visual-reference companies' posts, which are never read for content.
  -- Only fetched for their own company page or the «visual_reference» shelf.
  SELECT
    p.id, p.platform, p.post_type, p.caption, p.engagement, p.published_at,
    p.post_url, p.duration_ms, p.organization_id, p.social_account_id, p.repost_of,
    o.name_ar, o.developer_record_id, o.org_type,
    NULL::uuid, NULL::timestamptz, NULL::jsonb, NULL::jsonb, NULL::text
  FROM public.mkt_content_posts p
  JOIN public.mkt_organizations o        ON o.id = p.organization_id AND o.org_type = 'visual_reference'
  WHERE (p_org IS NOT NULL OR p_shelf = 'visual_reference')
    AND p.processing_status IN ('processed', 'partial')
),
filt AS (
  SELECT * FROM base
  WHERE (p_org      IS NULL OR organization_id = p_org)
    -- a visual-reference company's posts only on its own page or its shelf
    AND (org_type IS DISTINCT FROM 'visual_reference' OR p_org IS NOT NULL OR p_shelf = 'visual_reference')
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
   WHERE (p_shelf IS NULL OR f.content_type = p_shelf OR (p_shelf = 'visual_reference' AND f.org_type = 'visual_reference'))
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

CREATE OR REPLACE FUNCTION public.mkt_compute_share_of_voice(p_from date, p_to date, p_scope_type text DEFAULT 'market'::text, p_scope_key text DEFAULT ''::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_rows integer;
BEGIN
  WITH posts AS (
    SELECT cp.organization_id, cp.id,
           coalesce((cp.engagement->>'likes')::bigint,0)
         + coalesce((cp.engagement->>'comments')::bigint,0)
         + coalesce((cp.engagement->>'shares')::bigint,0)
         + coalesce((cp.engagement->>'views')::bigint,0) AS eng
    FROM mkt_content_posts cp
    WHERE cp.published_at >= p_from AND cp.published_at < (p_to + 1)
      AND cp.organization_id IS NOT NULL
      AND (p_scope_type = 'market' OR EXISTS (
            SELECT 1 FROM mkt_observed_facts f
            WHERE f.content_post_id = cp.id
              AND f.fact_type = CASE p_scope_type WHEN 'district' THEN 'district' ELSE 'city' END
              AND f.normalized_key = mkt_fact_norm_key(
                    CASE p_scope_type WHEN 'district' THEN 'district' ELSE 'city' END, p_scope_key)))
  ),
  ads AS (
    SELECT pa.organization_id, pa.id FROM mkt_paid_ads pa
    WHERE coalesce(pa.platform_started_at, pa.first_seen_at) >= p_from
      AND coalesce(pa.platform_started_at, pa.first_seen_at) < (p_to + 1)
      AND pa.organization_id IS NOT NULL
      AND p_scope_type = 'market'
  ),
  agg AS (
    SELECT o.id AS organization_id,
           coalesce(pc.c, 0) AS post_count,
           coalesce(ac.c, 0) AS ad_count,
           coalesce(pc.e, 0) AS engagement_total
    FROM mkt_organizations o
    LEFT JOIN (SELECT organization_id, count(*) c, sum(eng) e FROM posts GROUP BY 1) pc
           ON pc.organization_id = o.id
    LEFT JOIN (SELECT organization_id, count(*) c FROM ads GROUP BY 1) ac
           ON ac.organization_id = o.id
    WHERE coalesce(pc.c,0) + coalesce(ac.c,0) > 0
      AND o.org_type <> 'visual_reference'
  ),
  tot AS (SELECT sum(post_count + ad_count)::numeric AS total_n FROM agg)
  INSERT INTO mkt_share_of_voice
    (period_start, period_end, scope_type, scope_key, organization_id,
     post_count, ad_count, engagement_total, share_pct, computed_at)
  SELECT p_from, p_to, p_scope_type, coalesce(p_scope_key,''), organization_id,
         post_count, ad_count, engagement_total,
         round(100 * (post_count + ad_count) / nullif((SELECT total_n FROM tot),0), 2),
         now()
  FROM agg
  ON CONFLICT (period_start, period_end, scope_type, scope_key, organization_id)
  DO UPDATE SET post_count=EXCLUDED.post_count, ad_count=EXCLUDED.ad_count,
                engagement_total=EXCLUDED.engagement_total,
                share_pct=EXCLUDED.share_pct, computed_at=now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $function$;

CREATE OR REPLACE FUNCTION public.mkt_generate_trend_insights(p_window_days integer DEFAULT 30, p_min_prior integer DEFAULT 5, p_change_pct numeric DEFAULT 30)
 RETURNS TABLE(kind text, emitted integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_now      date := current_date;
  v_cur_from date := current_date - p_window_days;
  v_prv_from date := current_date - (p_window_days * 2);
  v_period   text := to_char(current_date, 'YYYY-MM');
  v_n        int;
BEGIN
  -- ── 1. Posting frequency changed (org) ────────────────────────────────────
  WITH windows AS (
    SELECT cp.organization_id,
           count(*) FILTER (WHERE cp.published_at >= v_cur_from) AS cur,
           count(*) FILTER (WHERE cp.published_at >= v_prv_from AND cp.published_at < v_cur_from) AS prv
    FROM mkt_content_posts cp
    WHERE cp.published_at >= v_prv_from AND cp.organization_id IS NOT NULL
    GROUP BY cp.organization_id
  ),
  scored AS (
    SELECT w.*, o.name_en, o.name_ar,
           round(100.0 * (w.cur - w.prv) / nullif(w.prv,0), 1) AS pct
    FROM windows w JOIN mkt_organizations o ON o.id = w.organization_id AND o.org_type <> 'visual_reference'
    WHERE w.prv >= p_min_prior
      AND abs(round(100.0 * (w.cur - w.prv) / nullif(w.prv,0), 1)) >= p_change_pct
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'posting_frequency_change', 'pfc:' || organization_id::text || ':' || v_period,
      coalesce(name_ar, name_en) || ' — ' ||
        CASE WHEN pct > 0 THEN 'ارتفع النشر ' ELSE 'انخفض النشر ' END || abs(pct)::text || '%',
      NULL, CASE WHEN pct > 0 THEN 'opportunity' ELSE 'warning' END,
      organization_id, NULL, NULL,
      jsonb_build_object('rule','posting_frequency_change',
        'current_window_posts', cur, 'prior_window_posts', prv,
        'change_pct', pct, 'window_days', p_window_days,
        'window_current', jsonb_build_array(v_cur_from, v_now),
        'window_prior', jsonb_build_array(v_prv_from, v_cur_from),
        'threshold_pct', p_change_pct, 'min_prior_posts', p_min_prior))
    AS emitted_id FROM scored) z WHERE z.emitted_id IS NOT NULL;
  kind := 'posting_frequency_change'; emitted := v_n; RETURN NEXT;

  -- ── 2. Advertiser gone inactive ───────────────────────────────────────────
  WITH prior_active AS (
    SELECT cp.organization_id, count(*) AS prv, max(cp.published_at) AS last_post
    FROM mkt_content_posts cp
    WHERE cp.published_at >= v_now - (p_window_days * 4) AND cp.published_at < v_cur_from
      AND cp.organization_id IS NOT NULL
    GROUP BY cp.organization_id HAVING count(*) >= p_min_prior
  ),
  silent AS (
    SELECT pa.*, o.name_en, o.name_ar FROM prior_active pa
    JOIN mkt_organizations o ON o.id = pa.organization_id AND o.org_type <> 'visual_reference'
    WHERE NOT EXISTS (SELECT 1 FROM mkt_content_posts c2
                      WHERE c2.organization_id = pa.organization_id AND c2.published_at >= v_cur_from)
      AND NOT EXISTS (SELECT 1 FROM mkt_paid_ads a2
                      WHERE a2.organization_id = pa.organization_id
                        AND coalesce(a2.platform_started_at, a2.first_seen_at) >= v_cur_from)
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'advertiser_inactive', 'inact:' || organization_id::text || ':' || v_period,
      coalesce(name_ar, name_en) || ' — توقّف النشاط التسويقي',
      NULL, 'warning', organization_id, NULL, NULL,
      jsonb_build_object('rule','advertiser_inactive',
        'posts_in_prior_period', prv, 'last_post_at', last_post,
        'silent_since_days', p_window_days, 'checked_organic_and_paid', true,
        'min_prior_posts', p_min_prior))
    AS emitted_id FROM silent) z WHERE z.emitted_id IS NOT NULL;
  kind := 'advertiser_inactive'; emitted := v_n; RETURN NEXT;

  -- ── 3. Platform shift ─────────────────────────────────────────────────────
  WITH pw AS (
    SELECT cp.organization_id, cp.platform,
           count(*) FILTER (WHERE cp.published_at >= v_cur_from) AS cur,
           count(*) FILTER (WHERE cp.published_at >= v_prv_from AND cp.published_at < v_cur_from) AS prv
    FROM mkt_content_posts cp
    WHERE cp.published_at >= v_prv_from AND cp.organization_id IS NOT NULL
    GROUP BY 1,2
  ),
  shifted AS (
    SELECT pw.*, o.name_en, o.name_ar,
           round((pw.cur::numeric) / nullif(pw.prv,0), 2) AS ratio
    FROM pw JOIN mkt_organizations o ON o.id = pw.organization_id
    WHERE pw.prv >= 3 AND (pw.cur >= pw.prv * 2 OR pw.cur * 2 <= pw.prv)
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'platform_shift',
      'pshift:' || organization_id::text || ':' || platform || ':' || v_period,
      coalesce(name_ar, name_en) || ' — ' || platform || ': ' ||
        CASE WHEN ratio >= 2 THEN 'تضاعف النشاط' ELSE 'تراجع النشاط للنصف' END,
      NULL, CASE WHEN ratio >= 2 THEN 'opportunity' ELSE 'info' END,
      organization_id, NULL, NULL,
      jsonb_build_object('rule','platform_shift', 'platform', platform,
        'current_window_posts', cur, 'prior_window_posts', prv, 'ratio', ratio,
        'window_days', p_window_days, 'min_prior_posts', 3))
    AS emitted_id FROM shifted) z WHERE z.emitted_id IS NOT NULL;
  kind := 'platform_shift'; emitted := v_n; RETURN NEXT;

  -- ── 4. Messaging shift ────────────────────────────────────────────────────
  WITH fw AS (
    SELECT f.organization_id, f.fact_type,
           count(*) FILTER (WHERE f.observed_at >= v_cur_from) AS cur,
           count(*) FILTER (WHERE f.observed_at >= v_prv_from AND f.observed_at < v_cur_from) AS prv
    FROM mkt_observed_facts f
    WHERE f.observed_at >= v_prv_from AND f.organization_id IS NOT NULL
      AND f.fact_type IN ('payment_plan','financing','offer','content_type','price')
    GROUP BY 1,2
  ),
  shifted AS (
    SELECT fw.*, o.name_en, o.name_ar,
           round(100.0 * (fw.cur - fw.prv) / nullif(fw.prv,0), 1) AS pct
    FROM fw JOIN mkt_organizations o ON o.id = fw.organization_id
    WHERE fw.prv >= 3 AND abs(round(100.0 * (fw.cur - fw.prv) / nullif(fw.prv,0), 1)) >= 50
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'messaging_shift',
      'mshift:' || organization_id::text || ':' || fact_type || ':' || v_period,
      coalesce(name_ar, name_en) || ' — ' ||
        CASE WHEN pct > 0 THEN 'تزايد استخدام ' ELSE 'تراجع استخدام ' END || fact_type ||
        ' (' || abs(pct)::text || '%)',
      NULL, 'info', organization_id, NULL, NULL,
      jsonb_build_object('rule','messaging_shift', 'fact_type', fact_type,
        'current_window_observations', cur, 'prior_window_observations', prv,
        'change_pct', pct, 'window_days', p_window_days,
        'threshold_pct', 50, 'min_prior_observations', 3))
    AS emitted_id FROM shifted) z WHERE z.emitted_id IS NOT NULL;
  kind := 'messaging_shift'; emitted := v_n; RETURN NEXT;

  -- ── 5. New COMMERCIAL offer detected (noise-filtered) ─────────────────────
  WITH first_seen AS (
    SELECT f.organization_id, f.fact_type,
           -- punctuation-insensitive novelty key: "تحكم ذكي - X" and
           -- "تحكم ذكي / X" are ONE claim
           regexp_replace(lower(f.normalized_key), '[^[:alnum:][:space:]؀-ۿ]', '', 'g') AS novelty_key,
           min(f.observed_at) AS first_at,
           (array_agg(f.value_text ORDER BY f.observed_at))[1] AS sample_value,
           (array_agg(f.id ORDER BY f.observed_at))[1] AS sample_fact_id,
           (array_agg(f.content_post_id ORDER BY f.observed_at))[1] AS sample_post_id
    FROM mkt_observed_facts f
    WHERE f.fact_type IN ('offer','financing','payment_plan')
      AND f.organization_id IS NOT NULL
      -- financing/payment_plan are inherently commercial; a bare `offer` must
      -- carry a commercial signal or it is a tagline, not an offer.
      AND (f.fact_type IN ('financing','payment_plan')
           OR f.value_text ~ '[0-9]'
           OR f.value_text ~* '(%|ريال|SAR|تقسيط|دفعة|خصم|تمويل|مجان|كاش|قسط|عرض خاص)')
    GROUP BY 1,2,3
  ),
  org_history AS (
    SELECT organization_id, min(observed_at) AS org_first_fact
    FROM mkt_observed_facts WHERE organization_id IS NOT NULL GROUP BY 1
  ),
  novel AS (
    SELECT fs.*, o.name_en, o.name_ar FROM first_seen fs
    JOIN mkt_organizations o ON o.id = fs.organization_id
    JOIN org_history h ON h.organization_id = fs.organization_id
    WHERE fs.first_at >= v_cur_from AND h.org_first_fact < v_cur_from
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'new_offer_detected',
      'newoffer:' || organization_id::text || ':' || fact_type || ':' || left(novelty_key, 120),
      coalesce(name_ar, name_en) || ' — عرض جديد: ' || left(sample_value, 80),
      sample_value, 'opportunity', organization_id, NULL, NULL,
      jsonb_build_object('rule','new_offer_detected', 'fact_type', fact_type,
        'value', sample_value, 'novelty_key', novelty_key, 'first_observed_at', first_at,
        'source_fact_id', sample_fact_id, 'source_post_id', sample_post_id,
        'commercial_signal_required', fact_type = 'offer', 'window_days', p_window_days))
    AS emitted_id FROM novel) z WHERE z.emitted_id IS NOT NULL;
  kind := 'new_offer_detected'; emitted := v_n; RETURN NEXT;

  -- ── 6. New marketer on a project (import-safe) ────────────────────────────
  -- Requires a PRIOR marketer link on the same project, observed >= 1 day
  -- earlier. The first marketer we ever record cannot be called "new" — we just
  -- started looking. Only a genuine ADDITION fires.
  WITH entered AS (
    SELECT po.project_id, po.organization_id, po.relationship_type,
           po.first_observed_at, po.confidence, po.human_confirmed,
           o.name_en, o.name_ar, r.data->>'project_name' AS project_name,
           (SELECT min(p2.first_observed_at) FROM mkt_project_organizations p2
             WHERE p2.project_id = po.project_id
               AND p2.relationship_type IN ('authorized_marketer','observed_marketer')
               AND p2.organization_id <> po.organization_id) AS prior_marketer_at
    FROM mkt_project_organizations po
    JOIN mkt_organizations o ON o.id = po.organization_id
    LEFT JOIN unified_records r ON r.id = po.project_id
    WHERE po.relationship_type IN ('authorized_marketer','observed_marketer')
      AND po.first_observed_at >= v_cur_from
  ),
  additions AS (
    SELECT * FROM entered
    WHERE prior_marketer_at IS NOT NULL
      AND prior_marketer_at < first_observed_at - interval '1 day'
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'new_marketer',
      'newmkt:' || project_id::text || ':' || organization_id::text || ':' || relationship_type,
      'مسوّق جديد على ' || coalesce(project_name, 'مشروع') || ' — ' || coalesce(name_ar, name_en),
      NULL, 'opportunity', organization_id, project_id, NULL,
      jsonb_build_object('rule','new_marketer', 'relationship_type', relationship_type,
        'first_observed_at', first_observed_at,
        'prior_marketer_first_observed_at', prior_marketer_at,
        'link_confidence', confidence, 'human_confirmed', human_confirmed,
        'guard', 'requires an existing marketer on the project >= 1 day earlier, '
              || 'so a bulk import cannot be reported as arrivals',
        'window_days', p_window_days))
    AS emitted_id FROM additions) z WHERE z.emitted_id IS NOT NULL;
  kind := 'new_marketer'; emitted := v_n; RETURN NEXT;

  -- ── 7. Advertised price movement ──────────────────────────────────────────
  WITH pw AS (
    SELECT f.organization_id,
           avg(f.value_num) FILTER (WHERE f.observed_at >= v_now - (p_window_days*3)) AS cur_avg,
           count(*)         FILTER (WHERE f.observed_at >= v_now - (p_window_days*3)) AS cur_n,
           avg(f.value_num) FILTER (WHERE f.observed_at >= v_now - (p_window_days*6)
                                      AND f.observed_at <  v_now - (p_window_days*3)) AS prv_avg,
           count(*)         FILTER (WHERE f.observed_at >= v_now - (p_window_days*6)
                                      AND f.observed_at <  v_now - (p_window_days*3)) AS prv_n
    FROM mkt_observed_facts f
    WHERE f.fact_type = 'price' AND f.value_num IS NOT NULL
      AND f.organization_id IS NOT NULL AND f.observed_at >= v_now - (p_window_days*6)
    GROUP BY 1
  ),
  moved AS (
    SELECT pw.*, o.name_en, o.name_ar,
           round(100.0 * (pw.cur_avg - pw.prv_avg) / nullif(pw.prv_avg,0), 1) AS pct
    FROM pw JOIN mkt_organizations o ON o.id = pw.organization_id
    WHERE pw.cur_n >= 2 AND pw.prv_n >= 2
      AND abs(round(100.0 * (pw.cur_avg - pw.prv_avg) / nullif(pw.prv_avg,0), 1)) >= 10
  )
  SELECT count(*) INTO v_n FROM (
    SELECT mkt_insight_emit(
      'price_movement', 'pmove:' || organization_id::text || ':' || v_period,
      coalesce(name_ar, name_en) || ' — ' ||
        CASE WHEN pct > 0 THEN 'ارتفاع الأسعار المعلنة ' ELSE 'انخفاض الأسعار المعلنة ' END
        || abs(pct)::text || '%',
      NULL, 'info', organization_id, NULL, NULL,
      jsonb_build_object('rule','price_movement',
        'current_avg', round(cur_avg), 'prior_avg', round(prv_avg),
        'current_observations', cur_n, 'prior_observations', prv_n,
        'change_pct', pct, 'currency', 'SAR', 'window_days', p_window_days * 3,
        'threshold_pct', 10, 'min_observations_each_side', 2))
    AS emitted_id FROM moved) z WHERE z.emitted_id IS NOT NULL;
  kind := 'price_movement'; emitted := v_n; RETURN NEXT;

  RETURN;
END $function$;

CREATE OR REPLACE FUNCTION public.mkt_script_exemplars(p_query vector, p_content_types text[], p_platforms text[], p_language text, p_exclude_org uuid, p_limit integer DEFAULT 40)
 RETURNS TABLE(content_post_id uuid, organization_id uuid, org_name text, platform text, post_type text, content_type text, language text, views bigint, similarity numeric, transcript_text text, transcript_segments jsonb, transcript_language text, ocr_text text, campaign_message text, selling_points jsonb, offer text, unit_types jsonb, district text, published_at timestamp with time zone, post_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  WITH tx AS (
    SELECT DISTINCT ON (t.content_post_id) t.content_post_id, t.text, t.segments, t.language
      FROM public.mkt_transcripts t
     WHERE t.status = 'done' AND length(COALESCE(t.text,'')) > 80
     ORDER BY t.content_post_id, (t.language = 'ar') DESC, length(t.text) DESC
  ), ocr AS (
    SELECT v.content_post_id, string_agg(NULLIF(v.text,''), ' | ') AS ocr_text
      FROM public.mkt_visual_text v WHERE v.status = 'done' GROUP BY v.content_post_id
  )
  SELECT p.id, p.organization_id, o.name_ar, p.platform, p.post_type,
         e.result->>'content_type', COALESCE(e.result->>'language', tx.language),
         NULLIF(p.engagement->>'views','')::bigint,
         (1 - (emb.embedding <=> p_query))::numeric AS similarity,
         tx.text, tx.segments, tx.language, ocr.ocr_text,
         NULLIF(e.result->>'campaign_message',''), e.result->'selling_points', NULLIF(e.result->>'offer',''),
         e.result->'unit_types', NULLIF(e.result->>'district',''), p.published_at, p.post_url
    FROM public.mkt_content_embeddings emb
    JOIN public.mkt_content_posts p ON p.id = emb.content_post_id
    LEFT JOIN public.mkt_organizations o ON o.id = p.organization_id
    LEFT JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done'
    LEFT JOIN tx ON tx.content_post_id = p.id
    LEFT JOIN ocr ON ocr.content_post_id = p.id
   WHERE p.post_type IN ('video','reel','short')
     AND (tx.text IS NOT NULL OR ocr.ocr_text IS NOT NULL)
     AND (p_content_types IS NULL OR cardinality(p_content_types) = 0 OR (e.result->>'content_type') = ANY(p_content_types))
     AND (p_exclude_org IS NULL OR p.organization_id IS DISTINCT FROM p_exclude_org)
     AND o.org_type IS DISTINCT FROM 'visual_reference'
     AND COALESCE((e.result->>'is_general_branding')::boolean, false) = false
   ORDER BY emb.embedding <=> p_query
   LIMIT GREATEST(p_limit, 1);
$function$;

CREATE OR REPLACE FUNCTION public.mkt_post_copy_examples(p_project_id uuid, p_limit integer DEFAULT 12, p_min_vs_usual numeric DEFAULT 1.5, p_per_account integer DEFAULT 2)
 RETURNS TABLE(post_id uuid, post_url text, organization_id uuid, published_at timestamp with time zone, content_type text, vs_usual numeric, relevance integer, on_image_text text, caption text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
WITH proj AS (
  SELECT r.data AS d FROM public.records r
   WHERE r.id = p_project_id AND r.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
),
readiness AS (
  SELECT CASE
    WHEN (d->>'project_status') IN ('available_on_map','under_construction','upcoming') THEN 'off_plan'
    WHEN (d->>'construction_status') = 'ready' THEN 'ready'
    WHEN (d->>'project_status') = 'available'
         AND coalesce(d->>'construction_status','') NOT IN ('excavation','foundations','structure','finishing','facade_installation','تحت-التطوير') THEN 'ready'
    WHEN (d->>'construction_status') IN ('excavation','foundations','structure','finishing','facade_installation','تحت-التطوير') THEN 'off_plan'
    ELSE 'unknown' END AS r
  FROM proj
),
stems AS (
  SELECT DISTINCT s FROM proj, jsonb_array_elements_text(coalesce(d->'unit_types','[]'::jsonb)) t,
    LATERAL unnest(CASE t
      WHEN 'apartment'  THEN ARRAY['شقة','شقق']
      WHEN 'apartments' THEN ARRAY['شقة','شقق']
      WHEN 'villa'      THEN ARRAY['فيلا','فلل']
      WHEN 'villas'     THEN ARRAY['فيلا','فلل']
      WHEN 'townhouse'  THEN ARRAY['تاون']
      WHEN 'townhouses' THEN ARRAY['تاون']
      WHEN 'floor'      THEN ARRAY['دور','أدوار','ادوار']
      WHEN 'floors'     THEN ARRAY['دور','أدوار','ادوار']
      WHEN 'duplex'     THEN ARRAY['دوبلكس']
      WHEN 'penthouse'  THEN ARRAY['بنتهاوس']
      WHEN 'studio'     THEN ARRAY['استوديو']
      ELSE ARRAY[t] END) AS s
),
base AS (
  SELECT p.id, p.post_url, p.social_account_id, p.organization_id, p.published_at, p.caption,
         e.result->>'content_type' AS content_type,
         public.try_numeric(p.engagement->>'views') AS views,
         public.try_numeric(p.engagement->>'likes') AS likes
    FROM public.mkt_content_posts p
    JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done'
   WHERE p.post_type IN ('image','carousel')
     AND p.published_at > now() - interval '12 months'
     AND p.repost_of IS NULL
     AND p.social_account_id IS NOT NULL
     AND length(coalesce(p.caption,'')) >= 40
     AND coalesce(e.result->>'is_general_branding','false') <> 'true'
     AND coalesce(e.result->>'content_type','') IN ('project_launch','offer','teaser','walkthrough')
     AND NOT EXISTS (SELECT 1 FROM public.mkt_organizations o
                      WHERE o.id = p.organization_id AND o.org_type IN ('internal', 'visual_reference'))
),
ocr AS (
  SELECT v.content_post_id, string_agg(v.text, ' | ' ORDER BY v.created_at) AS on_image
    FROM public.mkt_visual_text v
   WHERE v.content_post_id IN (SELECT id FROM base)
     AND v.source IN ('image','gemini')
     AND length(coalesce(v.text,'')) > 5
   GROUP BY v.content_post_id
),
scored AS (
  SELECT b.*, o.on_image,
         CASE WHEN b.views > 0 AND bl.median_views >= 50 THEN b.views / bl.median_views
              WHEN b.likes > 0 AND bl.median_likes >= 5  THEN b.likes / bl.median_likes END AS vs_usual,
         (b.views >= 20 * bl.median_views AND bl.median_views >= 50
            AND coalesce(b.likes,0) < 0.002 * b.views) AS likely_paid
    FROM base b
    JOIN ocr o ON o.content_post_id = b.id
    JOIN public.mkt_account_baseline_v bl ON bl.social_account_id = b.social_account_id
),
relevant AS (
  SELECT s.*,
    (CASE WHEN EXISTS (SELECT 1 FROM stems WHERE s.caption ILIKE '%'||stems.s||'%' OR s.on_image ILIKE '%'||stems.s||'%') THEN 1 ELSE 0 END)
  + (CASE (SELECT r FROM readiness)
       WHEN 'off_plan' THEN CASE WHEN s.caption ILIKE '%الخارطة%' OR s.on_image ILIKE '%الخارطة%'
                                   OR s.caption ILIKE '%تسليم%' OR s.caption ILIKE '%تحت الإنشاء%' THEN 1 ELSE 0 END
       WHEN 'ready'    THEN CASE WHEN s.caption ILIKE '%جاهز%' OR s.on_image ILIKE '%جاهز%'
                                   OR s.caption ILIKE '%فوري%' OR s.caption ILIKE '%استلام%' THEN 1 ELSE 0 END
       ELSE 0 END) AS relevance
    FROM scored s
   WHERE s.vs_usual >= p_min_vs_usual AND NOT coalesce(s.likely_paid, false)
),
spread AS (
  SELECT r.*, row_number() OVER (PARTITION BY r.social_account_id ORDER BY r.relevance DESC, r.vs_usual DESC) AS rn
    FROM relevant r
)
SELECT id, post_url, organization_id, published_at, content_type,
       round(vs_usual, 1), relevance,
       left(on_image, 500), left(caption, 900)
  FROM spread
 WHERE rn <= p_per_account
 ORDER BY relevance DESC, vs_usual DESC
 LIMIT p_limit;
$function$;

CREATE OR REPLACE FUNCTION public.mkt_design_read_due(p_limit integer DEFAULT 200)
 RETURNS TABLE(content_post_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH eng AS (
    SELECT CASE WHEN (SELECT value FROM mkt_settings WHERE key = 'content.design_reader') = '"openai"'::jsonb
                THEN 'openai:gpt-6.1-sol' ELSE 'gemini:gemini-3.8-flash' END AS model_used
  )
  SELECT p.id
    FROM mkt_content_posts p
    JOIN mkt_organizations o ON o.id = p.organization_id
    LEFT JOIN mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done'
                                 AND (e.model LIKE 'gemini%' OR e.model LIKE 'gpt-%')
   -- read competitor posts, and every visual-reference post (never read for content)
   WHERE (e.content_post_id IS NOT NULL
          OR (o.org_type = 'visual_reference' AND p.processing_status IN ('processed', 'partial')))
     AND EXISTS (SELECT 1 FROM mkt_content_media m WHERE m.content_post_id = p.id AND m.media_kind = 'image' AND m.download_status = 'stored')
     AND NOT EXISTS (SELECT 1 FROM mkt_content_media v WHERE v.content_post_id = p.id AND v.media_kind = 'video' AND v.download_status = 'stored')
     AND NOT EXISTS (
       SELECT 1 FROM visual_design_reads r
        WHERE r.subject_kind = 'competitor_post' AND r.subject_id = p.id AND r.level = 'post'
          AND r.model_used IN ('gemini:gemini-3.8-flash', 'openai:gpt-6.1-sol') AND r.status = 'done')
     AND NOT EXISTS (
       SELECT 1 FROM visual_design_reads r, eng
        WHERE r.subject_kind = 'competitor_post' AND r.subject_id = p.id AND r.level = 'post'
          AND r.model_used = eng.model_used AND r.status = 'failed'
          AND COALESCE((r.raw->>'attempts')::int, 1) >= 3)
   ORDER BY p.published_at DESC NULLS LAST, p.id
   LIMIT GREATEST(1, LEAST(p_limit, 2000));
$function$;

COMMIT;
