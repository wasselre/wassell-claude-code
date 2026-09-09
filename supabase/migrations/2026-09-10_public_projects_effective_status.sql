-- =============================================================================
-- 2026-09-10 — the website's project badge can no longer contradict the units.
--
-- Incident: سديم فلل showed a red «مباع» pill next to «16 وحدة متاحة» on
-- wassel.re/projects. The pill was the hand-picked `project_status` dropdown
-- (set to `sold_out` on 2026-08-14) while `available_units` — the trigger-
-- maintained rollup from the unit records — said 16. Nothing kept the two in
-- sync, and the search RPC passed the dropdown straight through.
--
-- Fix: `_pub_effective_project_status(data)` reconciles the dropdown against
-- the stored unit rollups (CLAUDE.md "Persisted project rollups"), and
-- `search_public_projects` publishes THAT instead of the raw dropdown:
--
--   • dropdown = sold_out  but available_units > 0            → 'available'
--   • dropdown ∈ {available, available_on_map}, unit_count > 0,
--     available_units = 0 AND every unit is sold or reserved
--     (sold_units + reserved_units >= unit_count)             → 'sold_out'
--   • anything else (under_construction / upcoming / unknown,
--     or projects with no unit data at all)                   → unchanged
--
-- «0 available» alone is NOT sold out: صفا 96 has 58 units that are all
-- `under_construction` (neither available nor sold) — the first draft of this
-- rule would have stamped it «مباع». Hence the sold+reserved test.
--
-- The status chips + the status filter on the page are built client-side from
-- this same value, so they stay consistent for free. Internal/admin surfaces
-- keep reading the raw dropdown — this is a customer-facing rule only, same
-- posture as the available_* price ranges.
--
-- Body of search_public_projects is otherwise VERBATIM from
-- 2026-09-08_public_projects_search_cities.sql (the live definition).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public._pub_effective_project_status(p_data jsonb)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN x.raw = 'sold_out' AND x.avail > 0                              THEN 'available'
           WHEN x.raw IN ('available','available_on_map')
                AND x.units > 0 AND x.avail = 0
                AND (x.sold + x.reserved) >= x.units                            THEN 'sold_out'
           ELSE x.raw
         END
  FROM (SELECT NULLIF(btrim(p_data->>'project_status'),'')                    AS raw,
               COALESCE(public.try_numeric(p_data->>'available_units'), 0)     AS avail,
               COALESCE(public.try_numeric(p_data->>'sold_units'), 0)          AS sold,
               COALESCE(public.try_numeric(p_data->>'reserved_units'), 0)      AS reserved,
               COALESCE(public.try_numeric(p_data->>'unit_count'), 0)          AS units) x
$$;

COMMENT ON FUNCTION public._pub_effective_project_status(jsonb) IS
  'Customer-facing project status: the project_status dropdown reconciled against the stored unit rollups (sold_out only when every unit is sold or reserved; never sold_out while units are available).';

CREATE OR REPLACE FUNCTION public.search_public_projects(
  p_lang text DEFAULT 'ar',
  p_filters jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '20s'
AS $$
DECLARE
  v_ap     uuid := public._pub_model_id('all_projects');
  v_units  uuid := public._pub_model_id('units');
  v_dev    uuid := public._pub_model_id('developers');
  v_lang   text := CASE WHEN lower(COALESCE(p_lang,'ar'))='en' THEN 'en' ELSE 'ar' END;
  v_f      jsonb := COALESCE(p_filters, '{}'::jsonb);

  v_districts text[];
  v_cities    text[];
  v_amen      text[];
  v_bed_in    numeric[];
  v_bed_min   numeric;
  v_bath_in   numeric[];
  v_bath_min  numeric;
  v_bmin      numeric;
  v_bmax      numeric;
  v_has_unit_filter boolean;

  v_geo       jsonb := v_f->'geo_items';
  v_tmp       uuid := gen_random_uuid();
  v_geo_ids   uuid[] := NULL;          -- NULL = no geo gate at all
  v_geo_meta  jsonb := NULL;

  v_projects  jsonb;
  v_facets    jsonb;
  v_total     int;
BEGIN
  -- ── Parse filters (tolerant: junk values are simply ignored) ─────────────
  --    cities[] + districts[] are OR-ed with each other (a whole city, or
  --    specific districts); everything else is AND-ed.
  IF jsonb_typeof(v_f->'districts')='array' THEN
    SELECT array_agg(x) INTO v_districts
    FROM jsonb_array_elements_text(v_f->'districts') x
    WHERE public._pub_try_uuid(x) IS NOT NULL;
  END IF;
  IF jsonb_typeof(v_f->'cities')='array' THEN
    SELECT array_agg(x) INTO v_cities
    FROM jsonb_array_elements_text(v_f->'cities') x
    WHERE public._pub_try_uuid(x) IS NOT NULL;
  END IF;
  IF jsonb_typeof(v_f->'amenities')='array' THEN
    SELECT array_agg(btrim(x)) INTO v_amen
    FROM jsonb_array_elements_text(v_f->'amenities') x WHERE btrim(x) <> '';
  END IF;
  IF jsonb_typeof(v_f->'bedrooms')='array' THEN
    SELECT array_agg(public.try_numeric(x)) INTO v_bed_in
    FROM jsonb_array_elements_text(v_f->'bedrooms') x WHERE public.try_numeric(x) IS NOT NULL;
  END IF;
  IF jsonb_typeof(v_f->'bathrooms')='array' THEN
    SELECT array_agg(public.try_numeric(x)) INTO v_bath_in
    FROM jsonb_array_elements_text(v_f->'bathrooms') x WHERE public.try_numeric(x) IS NOT NULL;
  END IF;
  v_bed_min  := public.try_numeric(v_f->>'bedrooms_min');
  v_bath_min := public.try_numeric(v_f->>'bathrooms_min');
  v_bmin     := public.try_numeric(v_f->>'budget_min');
  v_bmax     := public.try_numeric(v_f->>'budget_max');
  IF v_bed_in  IS NOT NULL AND cardinality(v_bed_in)=0  THEN v_bed_in  := NULL; END IF;
  IF v_bath_in IS NOT NULL AND cardinality(v_bath_in)=0 THEN v_bath_in := NULL; END IF;
  IF v_districts IS NOT NULL AND cardinality(v_districts)=0 THEN v_districts := NULL; END IF;
  IF v_cities IS NOT NULL AND cardinality(v_cities)=0 THEN v_cities := NULL; END IF;
  IF v_amen IS NOT NULL AND cardinality(v_amen)=0 THEN v_amen := NULL; END IF;
  v_has_unit_filter := v_bed_in IS NOT NULL OR v_bed_min IS NOT NULL
                    OR v_bath_in IS NOT NULL OR v_bath_min IS NOT NULL
                    OR v_bmin IS NOT NULL OR v_bmax IS NOT NULL;

  -- ── Geo gate: compile the visitor's items with a throwaway id, match, clean up
  IF jsonb_typeof(v_geo)='array' AND jsonb_array_length(v_geo) > 0 THEN
    BEGIN
      v_geo_meta := public.wassell_compile_geo_items(v_tmp, v_geo);

      WITH inc AS (
        SELECT item_id, geom, ref_geom, direction, district_ids
        FROM public.client_pref_geometry
        WHERE client_id = v_tmp AND polarity='include' AND validation_status='ok'
      ),
      exc AS (
        SELECT geom, ref_geom, direction, district_ids
        FROM public.client_pref_geometry
        WHERE client_id = v_tmp AND polarity='exclude' AND validation_status='ok'
      ),
      pub AS (
        SELECT r.id,
               public._pub_try_uuid(r.data->'location'->>'district') AS district_id,
               pp.geom AS pt
        FROM public.records r
        LEFT JOIN public.project_points pp ON pp.record_id = r.id AND pp.is_active
        WHERE r.model_id = v_ap AND COALESCE((r.data->>'is_public')::boolean,false)
      ),
      hits AS (
        SELECT p.id
        FROM pub p
        WHERE (
                NOT EXISTS (SELECT 1 FROM inc)      -- exclude-only filters: everything passes the include step
             OR EXISTS (
                  SELECT 1 FROM inc i
                  WHERE (i.geom IS NOT NULL AND p.pt IS NOT NULL
                         AND ST_Contains(i.geom, p.pt)
                         AND (i.direction IS NULL OR public.wassell_geo_dir_match(i.ref_geom, p.pt, i.direction)))
                     OR (p.district_id IS NOT NULL AND p.district_id = ANY(i.district_ids))
                )
              )
          AND NOT EXISTS (
                SELECT 1 FROM exc e
                WHERE public.wassell_geo_exclude_match(e.geom, e.ref_geom, e.direction, e.district_ids, p.pt, p.district_id)
              )
      )
      SELECT COALESCE(array_agg(id), '{}'::uuid[]) INTO v_geo_ids FROM hits;

      DELETE FROM public.client_pref_geometry WHERE client_id = v_tmp;
    EXCEPTION WHEN OTHERS THEN
      DELETE FROM public.client_pref_geometry WHERE client_id = v_tmp;
      RAISE;
    END;
    v_geo_meta := COALESCE(v_geo_meta, '{}'::jsonb) || jsonb_build_object('matched', cardinality(v_geo_ids));
  END IF;

  -- ── One statement: public set + their units are materialized ONCE and
  --    feed both the filtered cards and the (unfiltered) facets.
  --    Units join on the (model_id, data->>'project_id') expression index —
  --    no unit stores project_id as an array (verified 2026-09-08), and an OR
  --    on the jsonb shape forced a 96×8,873 nested loop (2 s per pass).
  WITH pub_all AS MATERIALIZED (
    SELECT r.id, r.data FROM public.records r
    WHERE r.model_id = v_ap AND COALESCE((r.data->>'is_public')::boolean,false)
  ),
  units_all AS MATERIALIZED (
    SELECT u.id, u.data, p.id AS pid,
           public.try_numeric(u.data->>'bedrooms')    AS beds,
           public.try_numeric(u.data->>'bathrooms')   AS baths,
           public.try_numeric(u.data->>'total_price') AS price,
           CASE
             WHEN public._rollup_status_is(u.data->>'unit_status','available') THEN 0
             WHEN lower(COALESCE(u.data->>'unit_status','')) LIKE '%construction%'
               OR COALESCE(u.data->>'unit_status','') LIKE '%إنشاء%' THEN 1
             WHEN public._rollup_status_is(u.data->>'unit_status','reserved')  THEN 2
             WHEN public._rollup_status_is(u.data->>'unit_status','sold')      THEN 9
             ELSE 3
           END AS status_rank
    FROM pub_all p
    JOIN public.records u
      ON u.model_id = v_units AND (u.data->>'project_id') = p.id::text
  ),
  pub AS (
    SELECT p.id, p.data
    FROM pub_all p
    WHERE (   (v_districts IS NULL AND v_cities IS NULL)
           OR (v_districts IS NOT NULL AND NULLIF(p.data->'location'->>'district','') = ANY(v_districts))
           OR (v_cities    IS NOT NULL AND NULLIF(p.data->'location'->>'city','')     = ANY(v_cities)))
      AND (v_amen IS NULL OR (jsonb_typeof(p.data->'preferred_amenities')='array'
                              AND p.data->'preferred_amenities' ?& v_amen))
      AND (v_geo_ids IS NULL OR p.id = ANY(v_geo_ids))
  ),
  matched AS (
    SELECT u.*
    FROM units_all u
    JOIN pub p ON p.id = u.pid
    WHERE u.status_rank < 9                                      -- never a sold unit
      AND ((v_bed_in IS NULL AND v_bed_min IS NULL)
           OR (v_bed_in IS NOT NULL AND u.beds = ANY(v_bed_in))
           OR (v_bed_min IS NOT NULL AND u.beds >= v_bed_min))
      AND ((v_bath_in IS NULL AND v_bath_min IS NULL)
           OR (v_bath_in IS NOT NULL AND u.baths = ANY(v_bath_in))
           OR (v_bath_min IS NOT NULL AND u.baths >= v_bath_min))
      AND (v_bmin IS NULL OR u.price >= v_bmin)
      AND (v_bmax IS NULL OR u.price <= v_bmax)
  ),
  ranked AS (
    SELECT m.*,
           count(*) OVER (PARTITION BY pid) AS matched_count,
           count(*) FILTER (WHERE status_rank = 0) OVER (PARTITION BY pid) AS matched_available,
           row_number() OVER (
             PARTITION BY pid
             ORDER BY status_rank,
                      price NULLS LAST,
                      (NULLIF(btrim(data->>'unit_plan'),'') IS NULL),   -- plan first
                      id
           ) AS rn
    FROM matched m
  ),
  best AS (SELECT * FROM ranked WHERE rn = 1),
  cards AS (
    SELECT
      p.id,
      b.id AS best_id,
      (b.status_rank = 0) AS best_available,
      public._pub_localized_text(p.id,'project_name',v_lang, p.data->>'project_name') AS name,
      jsonb_strip_nulls(jsonb_build_object(
        'id', p.id,
        'name', public._pub_localized_text(p.id,'project_name',v_lang, p.data->>'project_name'),
        'developer', (SELECT public._pub_localized_text(dv.id,'name',v_lang, dv.data->>'name')
                      FROM public.records dv
                      WHERE dv.id = public._pub_try_uuid(p.data->>'developer') AND dv.model_id = v_dev),
        'location', public._pub_geo(p.data->'location', v_lang),
        'district_id', NULLIF(p.data->'location'->>'district',''),
        'project_status', public._pub_opt('all_projects','project_status', public._pub_effective_project_status(p.data), v_lang),
        'hero', COALESCE(NULLIF(btrim(p.data->>'main_image'),''), (p.data->'project_images'->>0)),
        'available_price_range', public._pub_range(p.data->'available_price_range'),
        'available_units', public.try_numeric(p.data->>'available_units'),
        'unit_count', public.try_numeric(p.data->>'unit_count'),
        'bedroom_range', public._pub_range(p.data->'bedroom_range'),
        'bathroom_range', public._pub_range(p.data->'bathroom_range'),
        'unit_types', public._pub_opt_labels('all_projects','unit_types', p.data->'unit_types', v_lang),
        'amenities', (SELECT jsonb_agg(jsonb_build_object(
                          'value', a,
                          'label', (public._pub_opt('all_projects','preferred_amenities', a, v_lang))->>'label'))
                      FROM jsonb_array_elements_text(
                        CASE WHEN jsonb_typeof(p.data->'preferred_amenities')='array'
                             THEN p.data->'preferred_amenities' ELSE '[]'::jsonb END) a
                      WHERE btrim(a) <> ''),
        'lat', public.try_numeric(p.data->>'latitude'),
        'lng', public.try_numeric(p.data->>'longitude'),
        'matched_units', b.matched_count,
        'matched_available', b.matched_available,
        'best_unit', CASE WHEN b.id IS NULL THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
          'id', b.id,
          'unit_code', NULLIF(btrim(b.data->>'unit_code'),''),
          'unit_type', public._pub_opt('units','unit_type', b.data->>'unit_type', v_lang),
          'unit_status', public._pub_opt('units','unit_status', b.data->>'unit_status', v_lang),
          'floor', (public._pub_opt('units','floor', b.data->>'floor', v_lang))->>'label',
          'bedrooms', b.beds,
          'bathrooms', b.baths,
          'unit_area', public.try_numeric(b.data->>'unit_area'),
          'total_area', public.try_numeric(b.data->>'total_area'),
          'view', NULLIF(btrim(b.data->>'view'),''),
          'components', public._pub_opt_labels('units','unit_components', b.data->'unit_components', v_lang),
          'price', b.price,
          'native_price', public.try_numeric(b.data->>'source_price'),
          'native_currency', CASE WHEN public.try_numeric(b.data->>'source_price') IS NOT NULL
                                  THEN NULLIF(b.data->>'source_currency','') END,
          'plan_file', NULLIF(btrim(b.data->>'unit_plan'),'')
        )) END
      )) AS card
    FROM pub p
    LEFT JOIN best b ON b.pid = p.id
    WHERE (NOT v_has_unit_filter) OR b.id IS NOT NULL
  ),
  -- Facets over the WHOLE public set so chips never vanish when picked.
  d AS (
    SELECT p.data->'location'->>'district' AS did, count(*) AS n
    FROM pub_all p WHERE NULLIF(p.data->'location'->>'district','') IS NOT NULL
    GROUP BY 1
  ),
  f_districts AS (
    SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'id', d.did,
             'city_id', ds.city_lookup,
             'name', CASE WHEN v_lang='en' THEN COALESCE(NULLIF(ds.name_en,''), ds.name_ar) ELSE COALESCE(NULLIF(ds.name_ar,''), ds.name_en) END,
             'city', CASE WHEN v_lang='en' THEN COALESCE(NULLIF(ds.city_name_en,''), ds.city_name_ar) ELSE COALESCE(NULLIF(ds.city_name_ar,''), ds.city_name_en) END,
             'lat', ds.centroid_lat, 'lng', ds.centroid_lng,
             'count', d.n
           )) ORDER BY d.n DESC, ds.name_ar), '[]'::jsonb) AS j
    FROM d LEFT JOIN public.districts ds ON ds.id::text = d.did
  ),
  c AS (
    SELECT p.data->'location'->>'city' AS cid, count(*) AS n
    FROM pub_all p WHERE NULLIF(p.data->'location'->>'city','') IS NOT NULL
    GROUP BY 1
  ),
  f_cities AS (
    SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
             'id', c.cid,
             'name', CASE WHEN v_lang='en' THEN COALESCE(NULLIF(cs.name_en,''), cs.name_ar) ELSE COALESCE(NULLIF(cs.name_ar,''), cs.name_en) END,
             'country_code', cs.country_code,
             'count', c.n
           )) ORDER BY c.n DESC, cs.name_ar), '[]'::jsonb) AS j
    FROM c LEFT JOIN public.cities cs ON cs.id::text = c.cid
  ),
  f_beds AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('value', beds, 'count', n, 'projects', np) ORDER BY beds), '[]'::jsonb) AS j
    FROM (SELECT beds, count(*) AS n, count(DISTINCT pid) AS np
          FROM units_all WHERE beds IS NOT NULL AND status_rank < 9 GROUP BY beds) x
  ),
  f_baths AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('value', baths, 'count', n, 'projects', np) ORDER BY baths), '[]'::jsonb) AS j
    FROM (SELECT baths, count(*) AS n, count(DISTINCT pid) AS np
          FROM units_all WHERE baths IS NOT NULL AND status_rank < 9 GROUP BY baths) x
  ),
  f_amen AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'value', a, 'label', (public._pub_opt('all_projects','preferred_amenities', a, v_lang))->>'label', 'count', n
           ) ORDER BY n DESC, a), '[]'::jsonb) AS j
    FROM (SELECT a, count(*) AS n
          FROM pub_all p, jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(p.data->'preferred_amenities')='array'
                      THEN p.data->'preferred_amenities' ELSE '[]'::jsonb END) a
          WHERE btrim(a) <> ''
          GROUP BY a) x
  )
  SELECT
    (SELECT COALESCE(jsonb_agg(card ORDER BY (best_id IS NULL), (NOT COALESCE(best_available,false)), name), '[]'::jsonb) FROM cards),
    (SELECT count(*)::int FROM cards),
    jsonb_build_object(
      'cities',    (SELECT j FROM f_cities),
      'districts', (SELECT j FROM f_districts),
      'bedrooms',  (SELECT j FROM f_beds),
      'bathrooms', (SELECT j FROM f_baths),
      'amenities', (SELECT j FROM f_amen),
      'public_total', (SELECT count(*) FROM pub_all)
    )
  INTO v_projects, v_total, v_facets;

  RETURN jsonb_build_object(
    'projects', v_projects,
    'total', v_total,
    'facets', v_facets,
    'geo', v_geo_meta,
    'lang', v_lang
  );
END;
$$;

REVOKE ALL ON FUNCTION public.search_public_projects(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_projects(text,jsonb) TO anon, authenticated, service_role;

COMMIT;
