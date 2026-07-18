-- Preview the compiled geometry of location_items WITHOUT touching any client's
-- compiled rows. Reuses the REAL compiler (wassell_compile_geo_items) against a
-- throwaway client id inside one transaction, reads the per-item geometry back
-- as simplified GeoJSON, and deletes the temp rows. This is what lets the
-- DistrictMapPicker render element rules (radius circles, road buffers, zones,
-- and north/south/east/west-of reference lines) EXACTLY as the matcher will
-- evaluate them — no client-side re-implementation to drift.
--
-- SECURITY DEFINER (client_pref_geometry + geo_elements are not SPA-readable);
-- callable by any authenticated user — items are the caller's own input and the
-- output is derived display geometry, nothing sensitive.

CREATE OR REPLACE FUNCTION public.wassell_preview_geo_items(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tmp uuid := gen_random_uuid();
  v_out jsonb;
BEGIN
  PERFORM public.wassell_compile_geo_items(v_tmp, p_items);

  SELECT jsonb_agg(jsonb_build_object(
    'item_id', g.item_id,
    'kind', g.kind,
    'polarity', g.polarity,
    'direction', g.direction,
    'validation_status', g.validation_status,
    'geojson', CASE WHEN g.geom IS NOT NULL
      THEN ST_AsGeoJSON(ST_SimplifyPreserveTopology(g.geom, 0.0002), 5)::jsonb END,
    'ref_geojson', CASE WHEN g.ref_geom IS NOT NULL
      THEN ST_AsGeoJSON(ST_SimplifyPreserveTopology(g.ref_geom, 0.0002), 5)::jsonb END
  ) ORDER BY g.item_id)
  INTO v_out
  FROM public.client_pref_geometry g
  WHERE g.client_id = v_tmp;

  DELETE FROM public.client_pref_geometry WHERE client_id = v_tmp;

  RETURN coalesce(v_out, '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.wassell_preview_geo_items(jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.wassell_preview_geo_items(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_preview_geo_items(jsonb) TO service_role;
