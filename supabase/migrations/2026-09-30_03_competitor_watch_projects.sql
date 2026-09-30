-- ============================================================================
-- Competitor Watch: every project per company, and a Projects view (2026-09-30)
-- ----------------------------------------------------------------------------
-- 1. mkt_company_roster listed a company's top FOUR projects by post count, and
--    only projects it had posted about. So Riva's card never showed Aknan 25
--    even though Riva markets it. The list is now uncapped and is the union of
--      * projects the company is LINKED to in the CRM (developer / marketer —
--        mkt_project_organizations, kept in step with the project records), and
--      * projects it has posted about,
--    each with its post count (0 is a real answer: linked, never posted) and the
--    company's role. Re-emitted verbatim from the live definition with ONLY the
--    `proj` CTE changed.
-- 2. mkt_project_roster(): one row per project that is in our portfolio or that
--    anybody has posted about — its developer, its marketers, and every company
--    posting about it with that company's role (NULL role = posts about it but
--    the project record does not list it, i.e. a marketer we have not recorded).
-- ============================================================================
BEGIN;

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
  select o.id, o.name_ar as name, o.name_en, o.org_type, o.website,
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

CREATE OR REPLACE FUNCTION public.mkt_project_roster()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
with ours as (
  select distinct (data->>'project')::uuid as pid
    from records
   where model_id = '6609286a-f95a-45db-94e6-48cfa915ccbd'
     and data->>'project' ~ '^[0-9a-fA-F-]{36}$'
),
posts as (
  select e.primary_project_id as pid, p.organization_id as org, count(*) as n,
         count(*) filter (where p.published_at > now() - interval '90 days') as n90,
         max(p.published_at) as last_post
    from mkt_content_posts p
    join mkt_content_enrichment e on e.content_post_id = p.id and e.status = 'done'
   where e.primary_project_id is not null and p.organization_id is not null
   group by 1, 2
),
links as (
  select l.project_id as pid, l.organization_id as org,
         max(case when l.relationship_type = 'developer' then 'developer' else 'marketer' end) as role
    from mkt_project_organizations l
   where l.is_active and l.relationship_type in ('developer', 'authorized_marketer')
   group by 1, 2
),
pairs as (
  select coalesce(po.pid, l.pid) as pid, coalesce(po.org, l.org) as org, l.role,
         coalesce(po.n, 0) as n, coalesce(po.n90, 0) as n90, po.last_post
    from posts po full join links l on l.pid = po.pid and l.org = po.org
),
scope as (select pid from ours union select pid from posts),
-- aggregated ONCE per project (a per-project subquery over `pairs` re-ran the
-- whole join for every row and timed out)
per_project as (
  select x.pid, sum(x.n)::int as posts, sum(x.n90)::int as posts_90d, max(x.last_post) as last_post,
         jsonb_agg(jsonb_build_object(
             'org', o.id, 'name', o.name_ar, 'name_en', o.name_en, 'org_type', o.org_type,
             'role', x.role, 'posts', x.n, 'posts_90d', x.n90, 'last_post', x.last_post)
           order by x.n desc, o.name_ar) as companies
    from pairs x join mkt_organizations o on o.id = x.org
   group by x.pid
),
-- the Companies list is ~230 rows: resolve names from it, not from all records
co as (
  select id::text as id, data->>'name' as name
    from records where model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
)
select jsonb_build_object(
  'projects', coalesce(jsonb_agg(to_jsonb(row) order by row.ours desc, row.posts desc, row.name), '[]'::jsonb)
) from (
  select r.id, r.data->>'project_name' as name,
    d.name as developer,
    (select coalesce(jsonb_agg(c.name order by c.name), '[]'::jsonb)
       from co c where c.id = any (public.mkt_record_id_list(r.data->'marketer'))) as marketers,
    (o.pid is not null) as ours,
    coalesce(pp.posts, 0) as posts,
    coalesce(pp.posts_90d, 0) as posts_90d,
    pp.last_post,
    coalesce(pp.companies, '[]'::jsonb) as companies
  from scope s
  join records r on r.id = s.pid and r.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
  left join ours o on o.pid = r.id
  left join per_project pp on pp.pid = r.id
  left join co d on d.id = r.data->>'developer'
) row;
$function$;

REVOKE ALL ON FUNCTION public.mkt_project_roster() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mkt_project_roster() TO service_role;

COMMIT;
