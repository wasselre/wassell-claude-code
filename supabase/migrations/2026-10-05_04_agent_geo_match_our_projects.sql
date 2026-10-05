-- The agent's area search: OUR projects only (operator, 2026-10-05: "it should
-- only look in our projects, which are 96 — not the 1,000 projects").
--
-- 2026-10-05_03 dropped the 295,630 archived listing points but still matched
-- every project point (1,028 — the whole all_projects universe). The agent only
-- ever offers «مشاريعنا»: each our_projects record links its master all_projects
-- record through data->>'project', and the master owns the map point. So the
-- candidates are exactly those masters' points (96 on 2026-10-05).
--
-- Replaces wassell_geo_match_projects with wassell_geo_match_our_projects (same
-- include / direction / exclude rules over the smaller candidate set) and points
-- sales_agent_geo_match at it. The returned ids stay MASTER all_projects ids —
-- what the catalog already keys on.

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_geo_match_our_projects(p_client_id uuid)
 RETURNS TABLE(record_id uuid, matched_item_ids text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '20s'
AS $function$
  with ours as (
    select distinct (r.data->>'project')::uuid as master_id
    from public.records r
    join public.models m on m.id = r.model_id and m.name = 'our_projects'
    where r.data->>'project' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  cand as (
    select pp.record_id, pp.geom as pt, pp.district_id
    from public.project_points pp
    join ours o on o.master_id = pp.record_id
    where pp.is_active
  ),
  inc as (
    select item_id, geom, ref_geom, direction, district_ids
    from public.client_pref_geometry
    where client_id = p_client_id and polarity = 'include' and validation_status = 'ok'
  ),
  exc as (
    select geom, ref_geom, direction, district_ids
    from public.client_pref_geometry
    where client_id = p_client_id and polarity = 'exclude' and validation_status = 'ok'
  ),
  inc_hits as (
    select c.record_id, i.item_id, c.pt, c.district_id
    from inc i
    join cand c on ST_Contains(i.geom, c.pt)
    where i.geom is not null
      and (i.direction is null or public.wassell_geo_dir_match(i.ref_geom, c.pt, i.direction))
    union all
    select c.record_id, i.item_id, c.pt, c.district_id
    from inc i
    join cand c on i.geom is null and i.direction is not null
      and c.pt && case i.direction
        when 'north' then ST_MakeEnvelope(-180, ST_YMin(i.ref_geom), 180, 90, 4326)
        when 'south' then ST_MakeEnvelope(-180, -90, 180, ST_YMax(i.ref_geom), 4326)
        when 'east'  then ST_MakeEnvelope(ST_XMin(i.ref_geom), -90, 180, 90, 4326)
        when 'west'  then ST_MakeEnvelope(-180, -90, ST_XMax(i.ref_geom), 90, 4326)
        else ST_MakeEnvelope(-180, -90, 180, 90, 4326)
      end
    where (case i.direction
             when 'north' then ST_Y(c.pt) > ST_YMax(i.ref_geom)
             when 'south' then ST_Y(c.pt) < ST_YMin(i.ref_geom)
             when 'east'  then ST_X(c.pt) > ST_XMax(i.ref_geom)
             when 'west'  then ST_X(c.pt) < ST_XMin(i.ref_geom)
             else false
           end)
       or public.wassell_geo_dir_match(i.ref_geom, c.pt, i.direction)
  )
  select h.record_id, array_agg(distinct h.item_id) as matched_item_ids
  from inc_hits h
  where not exists (
    select 1 from exc e
    where public.wassell_geo_exclude_match(e.geom, e.ref_geom, e.direction, e.district_ids, h.pt, h.district_id)
  )
  group by h.record_id
  order by h.record_id
$function$;

REVOKE ALL ON FUNCTION public.wassell_geo_match_our_projects(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_geo_match_our_projects(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.sales_agent_geo_match(p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_key uuid := gen_random_uuid();
  v_compiled jsonb;
  v_ids uuid[];
BEGIN
  v_compiled := public.wassell_compile_geo_items(v_key, p_items);
  -- Our projects only — the 96 the agent can offer (2026-10-05).
  SELECT coalesce(array_agg(m.record_id), '{}'::uuid[]) INTO v_ids
    FROM public.wassell_geo_match_our_projects(v_key) m;
  DELETE FROM public.client_pref_geometry WHERE client_id = v_key;
  RETURN jsonb_build_object(
    'ids', to_jsonb(v_ids),
    'includes', coalesce(v_compiled->'includes', '0'::jsonb),
    'excludes', coalesce(v_compiled->'excludes', '0'::jsonb),
    'needs_review', coalesce(v_compiled->'needs_review', '0'::jsonb)
  );
END;
$function$;

-- The intermediate all-projects version (2026-10-05_03) has no other caller.
DROP FUNCTION IF EXISTS public.wassell_geo_match_projects(uuid);

COMMIT;
