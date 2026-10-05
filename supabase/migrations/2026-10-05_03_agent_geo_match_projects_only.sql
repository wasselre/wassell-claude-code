-- The WhatsApp sales agent's area search matched against EVERY geolocated
-- record — 1,028 project points AND 295,630 archived market-listing points —
-- to find projects. Live test 2026-10-05: «ابي غرب الرياض بس، مو الشرق» (west
-- zone, east zone excluded) hit the 20 s statement timeout, search_projects
-- failed, the brain ran out of time and the customer got the rules fallback
-- («زين، كم غرفة تبي؟») after 134 s. The agent only ever looks up PROJECTS.
--
-- wassell_geo_match_projects = wassell_geo_match with project_points only
-- (same include / direction / exclude rules, copied verbatim from the live
-- definition). sales_agent_geo_match switches to it. wassell_geo_match itself
-- is unchanged for every other caller.

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_geo_match_projects(p_client_id uuid)
 RETURNS TABLE(record_id uuid, matched_item_ids text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '20s'
AS $function$
  with inc as (
    select item_id, geom, ref_geom, direction, district_ids
    from public.client_pref_geometry
    where client_id = p_client_id and polarity = 'include' and validation_status = 'ok'
  ),
  exc as (
    select geom, ref_geom, direction, district_ids
    from public.client_pref_geometry
    where client_id = p_client_id and polarity = 'exclude' and validation_status = 'ok'
  ),
  cand as (
    select record_id, geom as pt, district_id from public.project_points where is_active
  ),
  inc_hits as (
    select pp.record_id, i.item_id, pp.geom as pt, pp.district_id
    from inc i
    join public.project_points pp on pp.is_active and ST_Contains(i.geom, pp.geom)
    where i.geom is not null
      and (i.direction is null or public.wassell_geo_dir_match(i.ref_geom, pp.geom, i.direction))
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

REVOKE ALL ON FUNCTION public.wassell_geo_match_projects(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_geo_match_projects(uuid) TO service_role;

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
  -- Projects only: the agent never looks up market listings (2026-10-05).
  SELECT coalesce(array_agg(m.record_id), '{}'::uuid[]) INTO v_ids
    FROM public.wassell_geo_match_projects(v_key) m;
  DELETE FROM public.client_pref_geometry WHERE client_id = v_key;
  RETURN jsonb_build_object(
    'ids', to_jsonb(v_ids),
    'includes', coalesce(v_compiled->'includes', '0'::jsonb),
    'excludes', coalesce(v_compiled->'excludes', '0'::jsonb),
    'needs_review', coalesce(v_compiled->'needs_review', '0'::jsonb)
  );
END;
$function$;

COMMIT;
