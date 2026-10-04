-- Sales agent ↔ the geography agent (2026-10-01).
--
-- The WhatsApp sales agent now understands location through the SAME geography
-- pipeline the reps' «تفضيلات العميل» card uses (extract → resolve → compile →
-- location_items). These two functions are the database side:
--
-- 1. sales_agent_geo_match(items) — which projects fall inside a set of
--    location_items. Same compile (wassell_compile_geo_items) and the same
--    matcher (wassell_geo_match) as the Project Finder, but under a THROWAWAY
--    key that is deleted before returning, so no client's saved geometry
--    (client_pref_geometry) is ever touched — the Finder's draft path writes
--    under the real client id; this one must not.
-- 2. sales_agent_side_of_road(points, roads) — for «النرجس شمال طريق الملك
--    سلمان ولا جنوبه؟»: which side of the road each point is on, with the same
--    rule the matcher uses for road bands (wassell_geo_dir_match: compare with
--    the closest point on the road) and the distance to it.
--
-- Service-role only: the agent runs server-side.

BEGIN;

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
  SELECT coalesce(array_agg(m.record_id), '{}'::uuid[]) INTO v_ids
    FROM public.wassell_geo_match(v_key) m;
  DELETE FROM public.client_pref_geometry WHERE client_id = v_key;
  RETURN jsonb_build_object(
    'ids', to_jsonb(v_ids),
    'includes', coalesce(v_compiled->'includes', '0'::jsonb),
    'excludes', coalesce(v_compiled->'excludes', '0'::jsonb),
    'needs_review', coalesce(v_compiled->'needs_review', '0'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sales_agent_side_of_road(p_points jsonb, p_road_ids uuid[])
 RETURNS TABLE(point_id text, north boolean, east boolean, main_side text, km numeric)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH road AS (
    SELECT ST_LineMerge(ST_Union(el.geom)) AS g
      FROM public.geo_elements el
     WHERE el.id = ANY(p_road_ids) AND el.geom IS NOT NULL
  ), pts AS (
    SELECT x->>'id' AS id,
           ST_SetSRID(ST_MakePoint((x->>'lng')::float8, (x->>'lat')::float8), 4326) AS g
      FROM jsonb_array_elements(coalesce(p_points, '[]'::jsonb)) x
     WHERE x->>'lat' ~ '^-?[0-9]+(\.[0-9]+)?$' AND x->>'lng' ~ '^-?[0-9]+(\.[0-9]+)?$'
  )
  SELECT p.id,
         public.wassell_geo_dir_match(r.g, p.g, 'north'),
         public.wassell_geo_dir_match(r.g, p.g, 'east'),
         -- The side that matters for this road: the larger offset from the
         -- closest point (an east-west road is crossed north/south, and vice versa).
         CASE WHEN abs(ST_Y(p.g) - ST_Y(ST_ClosestPoint(r.g, p.g)))
                   >= abs(ST_X(p.g) - ST_X(ST_ClosestPoint(r.g, p.g))) * cos(radians(ST_Y(p.g)))
              THEN CASE WHEN ST_Y(p.g) > ST_Y(ST_ClosestPoint(r.g, p.g)) THEN 'north' ELSE 'south' END
              ELSE CASE WHEN ST_X(p.g) > ST_X(ST_ClosestPoint(r.g, p.g)) THEN 'east' ELSE 'west' END
         END,
         round((ST_Distance(p.g::geography, r.g::geography) / 1000.0)::numeric, 1)
    FROM pts p CROSS JOIN road r
   WHERE r.g IS NOT NULL;
$function$;

REVOKE ALL ON FUNCTION public.sales_agent_geo_match(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_agent_side_of_road(jsonb, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_agent_geo_match(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_agent_side_of_road(jsonb, uuid[]) TO service_role;

COMMIT;
