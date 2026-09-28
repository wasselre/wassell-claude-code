-- office_outreach_candidates: deterministic order for paging.
--
-- PostgREST caps a response at 1,000 rows, and a city-wide match returns
-- thousands (5,031 offices for a Riyadh request, measured 2026-09-28), so the
-- SPA pages through the result with .range(). Paging re-runs the function per
-- page, which is only correct if the order is TOTAL — the old ORDER BY could tie
-- (same office name), so an office could appear on two pages or on none. The
-- final `d.id` makes it total. Body otherwise unchanged from
-- 2026-09-28_office_outreach.sql.

SET check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.office_outreach_candidates(p_request_id uuid, p_include_city boolean DEFAULT false)
RETURNS TABLE (
  office_id uuid, office_name text, phone text, district_id text, district_name text,
  match_kind text, last_contacted_at timestamptz, replied_before boolean,
  do_not_contact boolean, recently_contacted boolean, in_this_request boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
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

  SELECT array_agg(DISTINCT it->>'district_id') FILTER (WHERE COALESCE(it->>'polarity','include') <> 'exclude'),
         array_agg(DISTINCT it->>'district_id') FILTER (WHERE it->>'polarity' = 'exclude')
    INTO v_include, v_exclude
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_client.data->'location_items') = 'array'
                                   THEN v_client.data->'location_items' ELSE '[]'::jsonb END) it
   WHERE it->>'kind' = 'district' AND COALESCE(it->>'district_id','') <> '';

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
END $$;
