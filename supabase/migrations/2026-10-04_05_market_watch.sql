-- Market Watch (2026-10-04): the news of the market, read off competitor posts.
--
-- No new AI call — every item is DERIVED from what the post reader already
-- stored (content type, offer, price, the project pick, projects named that the
-- catalog lacks, the words on screen / spoken / in the caption), and every item
-- carries the posts that prove it.
--
--   new_project  the first time a project appears in competitor content: a
--                catalog project's first post by anyone, or a name we do not
--                have yet (mentioned_projects)
--   launch       the first launch post per company + project in the window
--   offer        an offer text not seen before for that company + project
--   price        a project's stated price differs from its previous one
--   event        exhibitions, signings, openings (content_type 'event')
--   sold_out     the post says it is sold out (AR / EN wording)

BEGIN;

CREATE OR REPLACE FUNCTION public.mkt_norm_phrase(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(regexp_replace(
           translate(coalesce(p, ''), 'أإآىةـ', 'ااايه'),
           '\s+', ' ', 'g')))
$$;

-- The amount in a price text: first number (Arabic-Indic digits and thousands
-- separators folded), scaled by «مليون» / «ألف» when written that way.
-- «تبدأ من 1.5 مليون ريال» → 1500000; «1,750,000 ريال قبل الخصم» → 1750000.
CREATE OR REPLACE FUNCTION public.mkt_price_number(p text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE t text; m text; v numeric;
BEGIN
  t := translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩٫٬', '0123456789.,');
  m := substring(t FROM '([0-9][0-9,]*(\.[0-9]+)?)');
  IF m IS NULL THEN RETURN NULL; END IF;
  v := replace(m, ',', '')::numeric;
  IF t ~ 'مليون|million' AND v < 1000 THEN v := v * 1000000;
  ELSIF t ~ '(ألف|الف|thousand|\yk\y)' AND v < 100000 THEN v := v * 1000; END IF;
  RETURN v;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN NULL;  -- a malformed number is "no amount", never a crash of the feed
END $$;

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
   WHERE e.primary_project_id IS NOT NULL AND p.published_at IS NOT NULL
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
