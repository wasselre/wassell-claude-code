-- A DRAWN AREA counts as the districts it covers (2026-10-05).
--
-- Operator: "I drew the area — why is it saying no?" A client's requested
-- places can be districts picked one by one (`location_items` kind
-- 'district') or a polygon drawn on the map (kind 'drawn_area'). Office
-- outreach read only the first kind, so a client described entirely by a
-- drawing reached ZERO offices, and the request-readiness check (unit type +
-- a district + one of budget/bedrooms/size) refused the «طلب غير مجاب» outcome.
--
-- New helper `office_outreach_client_districts(items)` returns
-- (district_id, polarity) for both kinds. A drawn area covers a district when
-- the district's centroid is inside the drawing OR a vertex of the drawing is
-- inside the district — the SAME rule the map picker uses for its coverage
-- label («منطقة مرسومة: اشبيلية، الازدهار، الاندلس +20»,
-- src/components/DistrictMapPicker.tsx coverageNames). The polygon is built
-- exactly as wassell_compile_geo_items builds it (ST_GeomFromGeoJSON +
-- ST_MakeValid). A malformed ring is skipped with a WARNING, never an error —
-- one bad drawing must not hide the client's other places.
--
-- office_outreach_candidates is re-emitted VERBATIM from the live definition
-- (pg_get_functiondef, 2026-10-05) with ONE change: v_include / v_exclude come
-- from the helper instead of reading district items only.
--
-- The JS twin of "does this client have a requested place" is
-- src/lib/clients/requestReadiness.ts hasRequestedDistrict (a drawn area with a
-- closed ring counts there too).

SET check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.office_outreach_client_districts(p_items jsonb)
 RETURNS TABLE(district_id text, polarity text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_item jsonb; v_poly geometry; v_pol text;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN RETURN; END IF;

  -- Districts picked one by one.
  RETURN QUERY
  SELECT DISTINCT it->>'district_id', CASE WHEN it->>'polarity' = 'exclude' THEN 'exclude' ELSE 'include' END
    FROM jsonb_array_elements(p_items) it
   WHERE it->>'kind' = 'district' AND COALESCE(it->>'district_id', '') <> '';

  -- Drawn areas → the districts they cover.
  FOR v_item IN SELECT it FROM jsonb_array_elements(p_items) it WHERE it->>'kind' = 'drawn_area' LOOP
    v_pol := CASE WHEN v_item->>'polarity' = 'exclude' THEN 'exclude' ELSE 'include' END;
    BEGIN
      v_poly := ST_CollectionExtract(ST_MakeValid(ST_SetSRID(
        ST_GeomFromGeoJSON(jsonb_build_object('type', 'Polygon', 'coordinates', jsonb_build_array(v_item->'coordinates'))::text),
        4326)), 3);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'office_outreach_client_districts: drawn area % skipped (malformed ring): %', v_item->>'id', SQLERRM;
      CONTINUE;
    END;
    IF v_poly IS NULL OR ST_IsEmpty(v_poly) THEN
      RAISE WARNING 'office_outreach_client_districts: drawn area % skipped (empty polygon)', v_item->>'id';
      CONTINUE;
    END IF;
    RETURN QUERY
    SELECT DISTINCT g.record_id::text, v_pol
      FROM geo_boundaries g
     WHERE g.tier = 'district'
       AND g.geom && v_poly
       AND (ST_Contains(v_poly, ST_Centroid(g.geom)) OR ST_Intersects(g.geom, ST_Points(v_poly)));
  END LOOP;
END $function$;

REVOKE ALL ON FUNCTION public.office_outreach_client_districts(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_outreach_client_districts(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.office_outreach_candidates(p_request_id uuid, p_include_city boolean DEFAULT false)
 RETURNS TABLE(office_id uuid, office_name text, phone text, district_id text, district_name text, match_kind text, last_contacted_at timestamp with time zone, replied_before boolean, do_not_contact boolean, recently_contacted boolean, in_this_request boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req records; v_client records;
  v_offices_model uuid := (SELECT id FROM models WHERE name = 'real_estate_offices');
  v_include text[]; v_exclude text[]; v_cities text[];
  v_recontact int := (SELECT recontact_days FROM office_outreach_settings WHERE id = 1);
BEGIN
  IF auth.uid() IS NULL OR NOT office_outreach_can_view_record(p_request_id) THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'WS422';
  END IF;
  SELECT * INTO v_req FROM records WHERE id = p_request_id;
  SELECT * INTO v_client FROM records
   WHERE id::text = office_outreach_first_id(v_req.data->'client_id');
  IF NOT FOUND THEN RETURN; END IF;

  -- 2026-10-05: districts picked one by one AND the districts a drawn area covers.
  SELECT array_agg(DISTINCT cd.district_id) FILTER (WHERE cd.polarity <> 'exclude'),
         array_agg(DISTINCT cd.district_id) FILTER (WHERE cd.polarity = 'exclude')
    INTO v_include, v_exclude
    FROM office_outreach_client_districts(v_client.data->'location_items') cd;

  SELECT array_agg(DISTINCT c) INTO v_cities FROM (
    SELECT jsonb_array_elements_text(CASE jsonb_typeof(v_client.data->'location'->'city')
             WHEN 'array' THEN v_client.data->'location'->'city'
             WHEN 'string' THEN jsonb_build_array(v_client.data->'location'->'city')
             ELSE '[]'::jsonb END) c
    UNION
    SELECT pc.record_id::text FROM geo_boundaries d
      JOIN geo_boundaries pc ON pc.tier = 'city' AND pc.external_id = d.parent_external_id
     WHERE d.tier = 'district' AND d.record_id::text = ANY (COALESCE(v_include, '{}'))
  ) x WHERE c IS NOT NULL AND c <> '';

  RETURN QUERY
  WITH o AS (
    SELECT r.id, NULLIF(btrim(r.data->>'office_name'), '') nm,
           ksa_phone_canon(r.data->>'mobile_number') ph,
           r.data->'location'->>'district' dist,
           r.data->'location'->>'city' city
      FROM records r
     WHERE r.model_id = v_offices_model
       AND COALESCE(r.data->>'mobile_number', '') <> ''
  ), matched AS (
    SELECT o.*, CASE WHEN o.dist = ANY (COALESCE(v_include, '{}')) THEN 'district' ELSE 'city' END mk
      FROM o
     WHERE (o.dist = ANY (COALESCE(v_include, '{}'))
            OR (p_include_city AND o.city = ANY (COALESCE(v_cities, '{}'))))
       AND NOT (COALESCE(o.dist, '') = ANY (COALESCE(v_exclude, '{}')))
       AND o.ph IS NOT NULL AND o.ph <> ''
  ), dedup AS (
    SELECT DISTINCT ON (ph) * FROM matched
     ORDER BY ph, (mk = 'district') DESC, (nm IS NOT NULL) DESC, id
  )
  SELECT d.id, d.nm, d.ph, d.dist,
         (SELECT g.name_ar FROM geo_boundaries g WHERE g.tier = 'district' AND g.record_id::text = d.dist LIMIT 1),
         d.mk,
         (SELECT max(oo.created_at) FROM office_outreach oo WHERE oo.office_phone = d.ph AND oo.status <> 'cancelled'),
         EXISTS (SELECT 1 FROM office_outreach oo WHERE oo.office_phone = d.ph AND oo.replied_at IS NOT NULL),
         EXISTS (SELECT 1 FROM office_do_not_contact n WHERE n.phone = d.ph),
         EXISTS (SELECT 1 FROM office_outreach oo WHERE oo.office_phone = d.ph AND oo.status IN ('queued','sent')
                  AND oo.created_at > now() - make_interval(days => v_recontact)),
         EXISTS (SELECT 1 FROM office_outreach oo WHERE oo.request_id = p_request_id AND oo.office_phone = d.ph
                  AND oo.status <> 'cancelled')
    FROM dedup d
   ORDER BY 8 DESC, (d.mk = 'district') DESC, (d.nm IS NOT NULL) DESC, d.nm NULLS LAST, d.id;
END $function$;
