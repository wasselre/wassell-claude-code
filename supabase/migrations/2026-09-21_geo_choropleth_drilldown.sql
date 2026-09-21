-- Projects & Inventory geography — true drill-down choropleth.
--
-- The Command Center's demand-vs-supply map is being rebuilt from centroid PINS
-- into filled admin polygons that drill country → region → city → district. The
-- polygons already exist for every tier in public.geo_boundaries, each carrying:
--   • record_id           — the CRM record this outline belongs to (region / city
--                           / district record); for the district tier this is the
--                           SAME id space as clients' location.district, so the
--                           demand-vs-supply metric joins EXACTLY.
--   • parent_external_id   — the hierarchy link (district → city → region), so a
--                           TypeScript rollup can sum district demand up to a city
--                           and a region without inventing a mapping.
--   • external_id          — this row's own key (what a child points at).
--
-- Two read-only, SECURITY DEFINER RPCs (same posture as
-- wassell_district_shapes_by_ids): one returns the lightweight hierarchy TREE (no
-- geometry — used once to build the rollup + names), the other returns the FILLED
-- geometry for ONE tier slice (all regions, or the cities of one region, or the
-- districts of one city) so payloads stay small and the map only ever loads the
-- level in view.
--
-- The metric (active-client demand) is NEVER computed here — it stays in the one
-- canonical TypeScript demand layer (buildActiveClientDemand → the Sales isActive
-- resolver). These functions serve geometry + hierarchy ONLY.
--
-- CI note: PostGIS may be absent on the ephemeral CI database, so the bodies are
-- not validated at CREATE time there (exercised on prod).
SET check_function_bodies = off;

-- ── The hierarchy tree (no geometry) ─────────────────────────────────────────
-- Every region / city / district for a country as flat rows. ~3,900 tiny rows for
-- SA; loaded once and turned into district→city→region parent maps client-side.
CREATE OR REPLACE FUNCTION public.wassell_geo_choropleth_tree(p_country text DEFAULT 'SA')
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '15s'
AS $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'tier', tier,
      'record_id', record_id,
      'external_id', external_id,
      'parent_external_id', parent_external_id,
      'name_ar', name_ar,
      'name_en', name_en
    )
    order by tier, coalesce(name_ar, name_en)
  ), '[]'::jsonb)
  from public.geo_boundaries
  where country_code = p_country
    and tier in ('region', 'city', 'district')
$function$;

-- ── The filled geometry for one tier slice ───────────────────────────────────
-- p_tier = 'region'  + p_parent_external_id = null            → every region
-- p_tier = 'city'    + p_parent_external_id = <region ext id> → that region's cities
-- p_tier = 'district'+ p_parent_external_id = <city ext id>   → that city's districts
--
-- Simplification tolerance is coarser for the big coarse tiers and finest for
-- districts, matching wassell_district_shapes_by_ids (0.0002) at the leaf.
CREATE OR REPLACE FUNCTION public.wassell_geo_choropleth_shapes(
  p_tier text,
  p_parent_external_id text DEFAULT NULL,
  p_country text DEFAULT 'SA'
)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '20s'
AS $function$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'tier', tier,
      'record_id', record_id,
      'external_id', external_id,
      'parent_external_id', parent_external_id,
      'name_ar', name_ar,
      'name_en', name_en,
      'geojson', ST_AsGeoJSON(
        ST_SimplifyPreserveTopology(
          geom,
          case p_tier when 'region' then 0.002 when 'city' then 0.0008 else 0.0002 end
        ), 5
      )::jsonb
    )
    order by coalesce(name_ar, name_en)
  ), '[]'::jsonb)
  from public.geo_boundaries
  where country_code = p_country
    and tier = p_tier
    and (p_parent_external_id is null or parent_external_id = p_parent_external_id)
$function$;

REVOKE ALL ON FUNCTION public.wassell_geo_choropleth_tree(text) FROM public;
REVOKE ALL ON FUNCTION public.wassell_geo_choropleth_shapes(text, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.wassell_geo_choropleth_tree(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.wassell_geo_choropleth_shapes(text, text, text) TO authenticated, service_role;
