-- ============================================================================
-- One "visual reference", not two (2026-10-06, follows _01 and _02/_03)
-- ----------------------------------------------------------------------------
-- Two sessions built "visual reference" the same day:
--   _01 (grades)  — a «سبب المتابعة» field on the CRM Companies record, copied to
--                   a new mkt_organizations.watch_role column. No behavior.
--   _02/_03       — org_type = 'visual_reference', which DOES carry behavior:
--                   such companies are collected and design-read but never read
--                   for content (no project match, Market Watch, share of voice,
--                   trends, copy or script examples).
-- Operator decision: keep ONE marker — org_type. The Companies-record field stays
-- as the place a person sets it: choosing «مرجع بصري فقط» now sets the watch
-- entry's org_type to 'visual_reference' (switching back restores the company
-- type), and the duplicate watch_role column is dropped. The grades from _01
-- (writing_grade / visual_grade / grade_note / graded_at) are unchanged.
-- Emaar, DAMAC and Diriyah, marked in _01, become visual references here.
-- ============================================================================
BEGIN;
SET LOCAL lock_timeout = '8s';

-- 1. the sync: the record's «سبب المتابعة» decides the org type -------------
CREATE OR REPLACE FUNCTION public.mkt_tg_company_to_org()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_org  public.mkt_organizations%ROWTYPE;
  v_type text;
  v_name text;
  v_wg   text;
  v_vg   text;
  v_note text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.mkt_organizations
       SET developer_record_id = NULL, status = 'archived',
           metadata = metadata || jsonb_build_object('archived_reason', 'company record deleted',
                                                     'company_record_id', OLD.id, 'archived_at', now())
     WHERE developer_record_id = OLD.id;
    RETURN OLD;
  END IF;

  -- A company watched only for its design is a visual reference whatever its
  -- company type; otherwise the company type decides, as before.
  v_type := CASE
    WHEN NEW.data->>'watch_role' = 'visual_reference' THEN 'visual_reference'
    WHEN NEW.data->>'company_type' = 'developer' THEN 'developer'
    WHEN NEW.data->>'company_type' = 'marketer' THEN 'marketer'
  END;
  v_name := nullif(btrim(NEW.data->>'name'), '');
  -- Unknown grades never reach the watch entry (its CHECK would refuse the
  -- whole company save): they read as not graded.
  v_wg   := CASE WHEN NEW.data->>'writing_grade' IN ('a','b','c','skip') THEN NEW.data->>'writing_grade' END;
  v_vg   := CASE WHEN NEW.data->>'visual_grade'  IN ('a','b','c','skip') THEN NEW.data->>'visual_grade'  END;
  v_note := nullif(btrim(NEW.data->>'grade_note'), '');

  SELECT * INTO v_org FROM public.mkt_organizations WHERE developer_record_id = NEW.id;
  IF NOT FOUND THEN
    IF v_name IS NULL THEN RETURN NEW; END IF;
    INSERT INTO public.mkt_organizations (name_ar, org_type, website, developer_record_id, status, metadata,
                                          writing_grade, visual_grade, grade_note, graded_at)
    VALUES (v_name, coalesce(v_type, 'developer'), nullif(btrim(NEW.data->>'website'), ''), NEW.id, 'active',
            jsonb_build_object('source', 'companies_list', 'company_record_id', NEW.id),
            v_wg, v_vg, v_note, CASE WHEN v_wg IS NOT NULL OR v_vg IS NOT NULL THEN now() END);
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF v_name IS NULL OR NOT (OLD.data->>'name' IS DISTINCT FROM NEW.data->>'name') THEN
      v_name := v_org.name_ar;
    END IF;
    -- No usable type on the record: keep the entry's — except that a company
    -- switched back from visual reference must not stay one.
    IF v_type IS NULL THEN
      v_type := CASE WHEN v_org.org_type = 'visual_reference' THEN 'developer' ELSE v_org.org_type END;
    END IF;
    IF v_name IS DISTINCT FROM v_org.name_ar OR v_type IS DISTINCT FROM v_org.org_type THEN
      UPDATE public.mkt_organizations SET name_ar = v_name, org_type = v_type WHERE id = v_org.id;
    END IF;
    IF v_wg IS DISTINCT FROM v_org.writing_grade OR v_vg IS DISTINCT FROM v_org.visual_grade
       OR v_note IS DISTINCT FROM v_org.grade_note THEN
      UPDATE public.mkt_organizations
         SET writing_grade = v_wg, visual_grade = v_vg, grade_note = v_note,
             graded_at = CASE WHEN v_wg IS DISTINCT FROM v_org.writing_grade OR v_vg IS DISTINCT FROM v_org.visual_grade
                              THEN now() ELSE v_org.graded_at END
       WHERE id = v_org.id;
    END IF;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.mkt_tg_company_to_org() FROM PUBLIC, anon, authenticated;

-- 2. roster + company page stop returning watch_role (re-emitted from the live
--    definitions; Competitor Watch reads org_type instead). Done BEFORE the
--    column drop: SQL function bodies are not dependency-tracked, so a drop
--    first would leave both functions failing at call time.
CREATE OR REPLACE FUNCTION public.mkt_company_roster()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with post as (
  select p.id, p.organization_id as org, p.social_account_id, p.platform, p.post_type, p.published_at,
         e.result, e.primary_project_id,
         coalesce((p.engagement->>'likes')::numeric, 0) as likes,
         coalesce((p.engagement->>'views')::numeric, (p.engagement->>'play_count')::numeric, 0) as views
    from mkt_content_posts p
    left join mkt_content_enrichment e on e.content_post_id = p.id and e.status = 'done'
),
acct_posts as (
  select social_account_id, count(*) as posts, max(published_at) as last_post
    from mkt_content_posts group by social_account_id
),
agg as (
  select org,
         count(*) as posts,
         count(*) filter (where published_at > now() - interval '90 days') as posts_90d,
         count(*) filter (where published_at > now() - interval '30 days') as posts_30d,
         max(published_at) as last_post,
         count(*) filter (where post_type = 'image') as fmt_image,
         count(*) filter (where post_type = 'carousel') as fmt_carousel,
         count(*) filter (where post_type in ('video','reel','short')) as fmt_video,
         count(*) filter (where result->>'content_type' = 'brand') as pur_brand,
         count(*) filter (where result->>'content_type' = 'project_launch') as pur_launch,
         count(*) filter (where result->>'content_type' = 'offer') as pur_offer,
         count(*) filter (where result->>'content_type' = 'teaser') as pur_teaser,
         count(*) filter (where result->>'content_type' = 'walkthrough') as pur_walkthrough,
         count(*) filter (where result->>'content_type' = 'event') as pur_event,
         count(*) filter (where result->>'content_type' = 'testimonial') as pur_testimonial,
         count(*) filter (where nullif(result->>'offer','') is not null and result->>'offer' <> 'null') as offer_posts,
         round(avg(likes) filter (where likes > 0))::int as avg_likes,
         round(avg(views) filter (where views > 0))::int as avg_views
    from post group by org
),
proj as (
  select org, jsonb_agg(jsonb_build_object('name', name, 'posts', n, 'role', role) order by n desc, name) as top_projects
    from (select org, name, sum(n)::int as n, max(role) as role
            from (select p.org, coalesce(r.data->>'project_name','—') as name, count(*) as n, null::text as role
                    from post p join records r on r.id = p.primary_project_id
                   where p.primary_project_id is not null group by p.org, 2
                  union all
                  select l.organization_id, coalesce(r.data->>'project_name','—'), 0,
                         case when l.relationship_type = 'developer' then 'developer' else 'marketer' end
                    from mkt_project_organizations l join records r on r.id = l.project_id
                   where l.is_active and l.relationship_type in ('developer','authorized_marketer')) u
           group by org, name) t
   group by org
),
dist as (
  select org, jsonb_agg(jsonb_build_object('name', name, 'posts', n) order by n desc) as top_districts
    from (select p.org, mkt_district_norm(p.result->>'district') as name, count(*) as n,
                 row_number() over (partition by p.org order by count(*) desc) as rn
            from post p
           where mkt_district_norm(p.result->>'district') is not null group by p.org, 2) t
   where rn <= 4 group by org
),
latest_offer as (
  select distinct on (org) org, btrim(result->>'offer') as offer_text, published_at as offer_at
    from post
   where nullif(btrim(result->>'offer'),'') is not null and result->>'offer' <> 'null'
   order by org, published_at desc nulls last
)
select jsonb_build_object(
  'companies', coalesce(jsonb_agg(to_jsonb(row) order by row.posts_90d desc, row.posts desc nulls last), '[]'::jsonb)
) from (
  select o.id, o.name_ar as name, o.name_en, o.org_type, o.website, o.developer_record_id, o.writing_grade, o.visual_grade, o.grade_note, o.graded_at,
    (select count(*) from mkt_observed_facts f where f.organization_id = o.id) as facts,
    (select count(*) from mkt_social_accounts sa where sa.organization_id = o.id and sa.is_active) as accounts,
    coalesce(a.posts,0) as posts, coalesce(a.posts_90d,0) as posts_90d, coalesce(a.posts_30d,0) as posts_30d,
    a.last_post,
    (select coalesce(sum(sa.followers),0) from mkt_social_accounts sa where sa.organization_id=o.id and sa.is_active) as followers,
    (select max(sa.last_incremental_at) from mkt_social_accounts sa where sa.organization_id=o.id) as last_pull,
    case when coalesce(a.posts_90d,0) > 0 then round(a.posts_90d / 12.85, 1) end as posts_per_week,
    jsonb_build_object('image', coalesce(a.fmt_image,0), 'carousel', coalesce(a.fmt_carousel,0), 'video', coalesce(a.fmt_video,0)) as formats,
    jsonb_build_object('brand', coalesce(a.pur_brand,0), 'project_launch', coalesce(a.pur_launch,0), 'offer', coalesce(a.pur_offer,0),
      'teaser', coalesce(a.pur_teaser,0), 'walkthrough', coalesce(a.pur_walkthrough,0), 'event', coalesce(a.pur_event,0),
      'testimonial', coalesce(a.pur_testimonial,0)) as purposes,
    coalesce(a.offer_posts,0) as offer_posts, lo.offer_text, lo.offer_at, a.avg_likes, a.avg_views,
    coalesce(pr.top_projects,'[]'::jsonb) as top_projects,
    coalesce(di.top_districts,'[]'::jsonb) as top_districts,
    (select coalesce(jsonb_agg(jsonb_build_object(
         'platform', sa.platform, 'handle', sa.handle, 'followers', sa.followers,
         'enabled', sa.collection_enabled, 'last_pull', sa.last_incremental_at,
         'cadence', sa.cadence->>'incremental',
         'posts', (select ap.posts from acct_posts ap where ap.social_account_id = sa.id),
         'last_post', (select ap.last_post from acct_posts ap where ap.social_account_id = sa.id)
       ) order by sa.platform), '[]'::jsonb)
       from mkt_social_accounts sa where sa.organization_id = o.id and sa.is_active) as account_list
  from mkt_organizations o
  left join agg a on a.org = o.id
  left join proj pr on pr.org = o.id
  left join dist di on di.org = o.id
  left join latest_offer lo on lo.org = o.id
  where exists (select 1 from mkt_social_accounts sa where sa.organization_id = o.id and sa.is_active)
) row;
$function$;

CREATE OR REPLACE FUNCTION public.mkt_company_profile(p_org uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH org AS (
  SELECT o.* FROM public.mkt_organizations o WHERE o.id = p_org
),
baseline AS MATERIALIZED (SELECT * FROM public.mkt_account_baseline_v),
posts AS (
  SELECT p.id, p.platform, p.post_type, p.published_at, p.social_account_id, p.post_url, p.caption,
         public.try_numeric(p.engagement->>'views') AS views,
         public.try_numeric(p.engagement->>'likes') AS likes,
         public.try_numeric(p.engagement->>'comments') AS comments,
         e.primary_project_id, e.result AS r, (e.result->>'content_type') AS content_type
    FROM public.mkt_content_posts p
    LEFT JOIN public.mkt_content_enrichment e ON e.content_post_id = p.id AND e.status = 'done'
   WHERE p.organization_id = p_org
),
recent AS (SELECT * FROM posts WHERE published_at > now() - interval '365 days'),
accounts AS (
  SELECT jsonb_agg(jsonb_build_object(
           'id', sa.id, 'platform', sa.platform, 'handle', sa.handle, 'display_name', sa.display_name,
           'profile_url', sa.profile_url, 'followers', COALESCE(am.followers, sa.followers),
           'followers_30d_ago', am30.followers,
           'collection_enabled', sa.collection_enabled, 'cadence', sa.cadence,
           'history_done_at', sa.history_done_at, 'last_synced_at', sa.last_synced_at,
           'posts_total', (SELECT count(*) FROM posts p WHERE p.social_account_id = sa.id),
           'posts_90d', (SELECT count(*) FROM posts p WHERE p.social_account_id = sa.id AND p.published_at > now() - interval '90 days'),
           'last_post_at', (SELECT max(p.published_at) FROM posts p WHERE p.social_account_id = sa.id),
           'usual_views', round(b.median_views), 'usual_likes', round(b.median_likes)
         ) ORDER BY COALESCE(am.followers, sa.followers) DESC NULLS LAST) AS j
    FROM public.mkt_social_accounts sa
    LEFT JOIN LATERAL (SELECT m.followers FROM public.mkt_account_metrics m WHERE m.social_account_id = sa.id ORDER BY m.captured_at DESC LIMIT 1) am ON true
    LEFT JOIN LATERAL (SELECT m.followers FROM public.mkt_account_metrics m WHERE m.social_account_id = sa.id AND m.captured_at <= now() - interval '30 days' ORDER BY m.captured_at DESC LIMIT 1) am30 ON true
    LEFT JOIN baseline b ON b.social_account_id = sa.id
   WHERE sa.organization_id = p_org
),
weeks AS (
  SELECT jsonb_agg(jsonb_build_object('week', w.wk, 'posts', COALESCE(c.n, 0)) ORDER BY w.wk) AS j
    FROM (SELECT generate_series(date_trunc('week', now() - interval '25 weeks'), date_trunc('week', now()), interval '1 week')::date AS wk) w
    LEFT JOIN (SELECT date_trunc('week', published_at)::date AS wk, count(*) n FROM recent GROUP BY 1) c ON c.wk = w.wk
),
months AS (
  SELECT jsonb_agg(jsonb_build_object('month', m.mo, 'posts', COALESCE(c.n, 0), 'avg_views', c.av, 'avg_likes', c.al) ORDER BY m.mo) AS j
    FROM (SELECT generate_series(date_trunc('month', now() - interval '11 months'), date_trunc('month', now()), interval '1 month')::date AS mo) m
    LEFT JOIN (SELECT date_trunc('month', published_at)::date AS mo, count(*) n,
                      round(avg(views) FILTER (WHERE views > 0)) av, round(avg(likes) FILTER (WHERE likes > 0)) al
                 FROM recent GROUP BY 1) c ON c.mo = m.mo
),
top_posts AS (
  SELECT jsonb_agg(t ORDER BY t.rank_score DESC NULLS LAST) AS j FROM (
    SELECT p.id, p.platform, p.post_type AS format, p.content_type, p.published_at, p.post_url,
           p.views, p.likes, p.comments,
           COALESCE(NULLIF(p.r->>'campaign_message',''), LEFT(p.caption, 140)) AS summary,
           (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name') FROM public.unified_records ur WHERE ur.id = p.primary_project_id) AS project_name,
           (p.views >= 20 * b.median_views AND b.median_views >= 50 AND COALESCE(p.likes, 0) < 0.002 * p.views) AS likely_paid,
           round(CASE WHEN p.views > 0 AND b.median_views >= 50 THEN p.views / b.median_views
                      WHEN p.likes > 0 AND b.median_likes >= 5 THEN p.likes / b.median_likes END, 1) AS vs_usual,
           (SELECT m.stored_url FROM public.mkt_content_media m
             WHERE m.content_post_id = p.id AND m.download_status = 'stored' AND m.stored_url IS NOT NULL
             ORDER BY (m.media_kind = 'thumbnail') DESC, (m.media_kind = 'image') DESC, m.created_at LIMIT 1) AS thumb_url,
           -- ranked against the account's own usual post, so a small account's hit shows
           COALESCE(CASE WHEN p.views > 0 AND b.median_views >= 50 THEN p.views / b.median_views
                         WHEN p.likes > 0 AND b.median_likes >= 5 THEN p.likes / b.median_likes END, 0) AS rank_score
      FROM recent p LEFT JOIN baseline b ON b.social_account_id = p.social_account_id
     ORDER BY rank_score DESC NULLS LAST LIMIT 12
  ) t
),
mix AS (
  SELECT jsonb_build_object(
    'content_type', (SELECT jsonb_object_agg(k, n) FROM (SELECT COALESCE(content_type, 'unknown') k, count(*) n FROM recent GROUP BY 1) a),
    'format',       (SELECT jsonb_object_agg(k, n) FROM (SELECT COALESCE(post_type, 'unknown') k, count(*) n FROM recent GROUP BY 1) a),
    'platform',     (SELECT jsonb_object_agg(k, n) FROM (SELECT platform k, count(*) n FROM recent GROUP BY 1) a)
  ) AS j
),
projects AS (
  SELECT jsonb_agg(t ORDER BY t.posts DESC) AS j FROM (
    SELECT p.primary_project_id AS project_id,
           (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name') FROM public.unified_records ur WHERE ur.id = p.primary_project_id) AS name,
           count(*) AS posts, max(p.published_at) AS last_post_at,
           round(avg(p.views) FILTER (WHERE p.views > 0)) AS avg_views, round(avg(p.likes) FILTER (WHERE p.likes > 0)) AS avg_likes
      FROM posts p WHERE p.primary_project_id IS NOT NULL GROUP BY 1
  ) t
),
offers AS (
  SELECT jsonb_agg(t ORDER BY t.published_at DESC) AS j FROM (
    SELECT p.id, p.published_at, p.r->>'offer' AS offer, NULLIF(p.r->>'price','') AS price, NULLIF(p.r->>'payment_plan','') AS payment_plan,
           (SELECT COALESCE(ur.data->>'project_name', ur.data->>'name') FROM public.unified_records ur WHERE ur.id = p.primary_project_id) AS project_name
      FROM posts p WHERE COALESCE(p.r->>'offer','') <> '' ORDER BY p.published_at DESC NULLS LAST LIMIT 15
  ) t
),
messages AS (
  SELECT jsonb_agg(t ORDER BY t.published_at DESC) AS j FROM (
    SELECT p.id, p.published_at, p.r->>'campaign_message' AS message, p.content_type
      FROM recent p WHERE COALESCE(p.r->>'campaign_message','') <> '' ORDER BY p.published_at DESC NULLS LAST LIMIT 15
  ) t
),
unknown_projects AS (
  SELECT jsonb_agg(jsonb_build_object('name', name, 'posts', n) ORDER BY n DESC) AS j FROM (
    SELECT btrim(x) AS name, count(*) n FROM posts p, jsonb_array_elements_text(COALESCE(p.r->'mentioned_projects','[]'::jsonb)) x
     WHERE btrim(x) <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 20
  ) t
),
visual AS (
  SELECT jsonb_agg(jsonb_build_object('tag', tag, 'shots', n) ORDER BY n DESC) AS j FROM (
    SELECT t AS tag, count(*) n
      FROM public.mkt_cv_shots s JOIN public.mkt_cv_videos v ON v.id = s.video_id, unnest(s.tags) t
     WHERE v.organization_id = p_org AND v.owner = 'competitor'
     GROUP BY 1 ORDER BY 2 DESC LIMIT 20
  ) t
)
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM org) THEN NULL ELSE jsonb_build_object(
  'organization', (SELECT jsonb_build_object('id', id, 'name_ar', name_ar, 'name_en', name_en, 'org_type', org_type,
                    'developer_record_id', developer_record_id, 'website', website, 'hq_city', hq_city, 'status', status,
                    'writing_grade', writing_grade, 'visual_grade', visual_grade, 'grade_note', grade_note, 'graded_at', graded_at) FROM org),
  'totals', jsonb_build_object(
     'posts', (SELECT count(*) FROM posts), 'posts_12m', (SELECT count(*) FROM recent),
     'posts_30d', (SELECT count(*) FROM posts WHERE published_at > now() - interval '30 days'),
     'first_post_at', (SELECT min(published_at) FROM posts), 'last_post_at', (SELECT max(published_at) FROM posts),
     'avg_views_12m', (SELECT round(avg(views) FILTER (WHERE views > 0)) FROM recent),
     'avg_likes_12m', (SELECT round(avg(likes) FILTER (WHERE likes > 0)) FROM recent)),
  'accounts', COALESCE((SELECT j FROM accounts), '[]'::jsonb),
  'weeks', COALESCE((SELECT j FROM weeks), '[]'::jsonb),
  'months', COALESCE((SELECT j FROM months), '[]'::jsonb),
  'top_posts', COALESCE((SELECT j FROM top_posts), '[]'::jsonb),
  'mix', (SELECT j FROM mix),
  'projects', COALESCE((SELECT j FROM projects), '[]'::jsonb),
  'offers', COALESCE((SELECT j FROM offers), '[]'::jsonb),
  'messages', COALESCE((SELECT j FROM messages), '[]'::jsonb),
  'unknown_projects', COALESCE((SELECT j FROM unknown_projects), '[]'::jsonb),
  'visual_style', COALESCE((SELECT j FROM visual), '[]'::jsonb)
) END;
$function$;

-- 3. the duplicate column goes ----------------------------------------------
ALTER TABLE public.mkt_organizations DROP CONSTRAINT IF EXISTS mkt_organizations_watch_role_chk;
ALTER TABLE public.mkt_organizations DROP COLUMN IF EXISTS watch_role;

-- 4. companies already marked on their record become visual references
--    (Emaar, DAMAC, Diriyah). A no-op data write re-runs the sync trigger.
UPDATE public.records
   SET data = data
 WHERE model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
   AND data->>'watch_role' = 'visual_reference';

-- 5. checks
DO $assert$
DECLARE v int;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'mkt_organizations' AND column_name = 'watch_role') THEN
    RAISE EXCEPTION 'WATCH_ROLE_COLUMN_STILL_PRESENT';
  END IF;
  -- every company marked visual reference on its record is one on its watch entry, and vice versa
  SELECT count(*) INTO v FROM public.records r JOIN public.mkt_organizations o ON o.developer_record_id = r.id
   WHERE r.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
     AND ((r.data->>'watch_role' = 'visual_reference') <> (o.org_type = 'visual_reference'));
  IF v > 0 THEN RAISE EXCEPTION 'VISUAL_REFERENCE_OUT_OF_SYNC: %', v; END IF;
  IF EXISTS (SELECT 1 FROM public.mkt_organizations WHERE id = 'd299c9f7-6dac-4abc-bf04-7fff63780ed0')
     AND (SELECT count(*) FROM public.mkt_organizations WHERE org_type = 'visual_reference'
           AND id IN ('90717088-33d1-413f-bc70-12974a2c6636','d299c9f7-6dac-4abc-bf04-7fff63780ed0','797848de-8894-484e-b243-023bd7206017')) <> 3 THEN
    RAISE EXCEPTION 'EMAAR_DAMAC_DIRIYAH_NOT_VISUAL_REFERENCES';
  END IF;
  PERFORM public.mkt_company_roster();
END $assert$;

COMMIT;
