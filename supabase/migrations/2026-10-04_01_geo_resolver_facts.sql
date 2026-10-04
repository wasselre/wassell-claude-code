-- Geography agent: read-only map facts for the resolver's safety checks.
--
-- Context (2026-10-03, geo road/landmark fix): the resolver now turns a
-- resolved place back into "needs confirm" when a map fact contradicts it,
-- instead of trusting word-order rules. Two facts need the database:
--
--   wassell_geo_road_axis(road, districts?)  how much a road runs east-west vs
--     north-south — locally (inside the given districts), else in a window
--     around them, else along the whole road. "North of King Fahd Road" is
--     meaningless (it runs north-south: east-west share 0.341), so the
--     TypeScript caller asks instead of drawing a band. Raw metres only; the
--     thresholds live in api/_lib/geoPreference/invariants.ts.
--   wassell_geo_names_in_text(text)  every catalogued element name / alias of
--     2+ words that occurs in the text — so «الرياض» inside «الرياض بارك» is
--     recognised as part of a venue name, not the city. A candidate generator:
--     the caller verifies whole-word occurrences.
--
-- Plus a spoken alias «جامعة الأميرة نورة» for BOTH Princess Nourah campuses
-- (official names are longer; the campuses are ~9 km apart, so the resolver
-- ASKS which one — it never picks a campus by guess).
--
-- Both functions are STABLE, SECURITY DEFINER with a pinned search_path,
-- service_role only, and raise nothing (never 40001/40P01). No view is touched.
-- check_function_bodies=off keeps the file loadable on a DB without PostGIS.

BEGIN;
SET LOCAL check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.wassell_geo_road_axis(
  p_road_external_id text,
  p_district_ids uuid[] DEFAULT NULL,
  p_window_deg double precision DEFAULT 0.03,
  p_min_len_m double precision DEFAULT 300
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '5s'
AS $function$
DECLARE
  v_road geometry; v_area geometry; v_part geometry; v_scope text := 'road'; v jsonb;
BEGIN
  SELECT ST_Force2D(g.geom) INTO v_road FROM public.geo_elements g
   WHERE g.external_id = p_road_external_id AND g.is_active LIMIT 1;
  IF v_road IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
  IF p_district_ids IS NOT NULL AND cardinality(p_district_ids) > 0 THEN
    SELECT ST_CollectionExtract(ST_Union(ST_MakeValid(ST_Force2D(b.geom))), 3) INTO v_area
      FROM public.district_boundaries b
     WHERE b.is_active AND b.district_record_id = ANY(p_district_ids);
  END IF;
  IF v_area IS NOT NULL AND NOT ST_IsEmpty(v_area) THEN
    v_part := ST_CollectionExtract(ST_Intersection(v_road, v_area), 2);
    IF v_part IS NOT NULL AND NOT ST_IsEmpty(v_part) AND ST_Length(v_part::geography) >= p_min_len_m THEN
      v_scope := 'district';
    ELSE
      v_part := ST_CollectionExtract(ST_Intersection(v_road, ST_Expand(ST_Envelope(v_area), p_window_deg)), 2);
      IF v_part IS NOT NULL AND NOT ST_IsEmpty(v_part) AND ST_Length(v_part::geography) >= p_min_len_m THEN
        v_scope := 'window';
      ELSE
        v_part := NULL;
      END IF;
    END IF;
  END IF;
  IF v_part IS NULL THEN v_part := ST_CollectionExtract(v_road, 2); v_scope := 'road'; END IF;
  SELECT jsonb_build_object(
           'found', true, 'scope', v_scope,
           'ew_m', round(coalesce(sum(abs(ST_X(s.p2) - ST_X(s.p1)) * cos(radians((ST_Y(s.p1) + ST_Y(s.p2)) / 2))), 0) * 111320.0),
           'ns_m', round(coalesce(sum(abs(ST_Y(s.p2) - ST_Y(s.p1))), 0) * 110574.0))
    INTO v
    FROM (SELECT ST_PointN(d.geom, i) AS p1, ST_PointN(d.geom, i + 1) AS p2
            FROM ST_Dump(v_part) d, generate_series(1, ST_NPoints(d.geom) - 1) AS i) s;
  RETURN v;
END
$function$;

CREATE OR REPLACE FUNCTION public.wassell_geo_names_in_text(p_text text)
RETURNS TABLE(external_id text, name text, category text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '5s'
AS $function$
  WITH t AS (
    SELECT ' ' || regexp_replace(regexp_replace(public.wassell_search_norm(p_text), '[ً-ٰٟ]', '', 'g'),
                                 '[^0-9a-zء-يٱ]+', ' ', 'g') || ' ' AS txt
  ),
  names AS (
    SELECT e.external_id, n.name, e.category
      FROM public.geo_elements e
      CROSS JOIN LATERAL (VALUES (e.name_ar), (e.name_en), (e.display_name)) AS n(name)
     WHERE e.is_active AND e.is_searchable AND e.review_status = 'approved' AND coalesce(n.name, '') <> ''
    UNION
    SELECT e.external_id, a.alias, e.category
      FROM public.geo_element_aliases a JOIN public.geo_elements e ON e.id = a.element_id
     WHERE e.is_active AND e.is_searchable AND e.review_status = 'approved'
  ),
  norm AS (
    SELECT external_id, name, category,
           btrim(regexp_replace(regexp_replace(public.wassell_search_norm(name), '[ً-ٰٟ]', '', 'g'),
                                '[^0-9a-zء-يٱ]+', ' ', 'g')) AS nn
      FROM names
  )
  SELECT n.external_id, n.name, n.category
    FROM norm n, t
   WHERE n.nn LIKE '% %'
     -- no leading-space anchor on purpose: «بالرياض بارك» must still generate
     -- «الرياض بارك»; the caller's clitic-aware whole-word check decides.
     AND position(n.nn || ' ' IN t.txt) > 0
   LIMIT 300
$function$;

-- Supabase default privileges grant EXECUTE on new public functions to anon +
-- authenticated as well: revoke them explicitly, not only PUBLIC.
REVOKE ALL ON FUNCTION public.wassell_geo_road_axis(text, uuid[], double precision, double precision) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_geo_road_axis(text, uuid[], double precision, double precision) TO service_role;
REVOKE ALL ON FUNCTION public.wassell_geo_names_in_text(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_geo_names_in_text(text) TO service_role;

-- Spoken alias for both Princess Nourah campuses. geo_element_aliases has no
-- unique key, so de-duplicate with NOT EXISTS (ON CONFLICT would never fire).
-- Guarded so a fresh / CI database replays.
DO $$
BEGIN
  IF to_regclass('public.geo_element_aliases') IS NOT NULL AND to_regclass('public.geo_elements') IS NOT NULL THEN
    INSERT INTO public.geo_element_aliases (element_id, external_id, alias, alias_norm, lang, source)
    SELECT e.id, e.external_id, v.alias, lower(btrim(v.alias)), 'ar', 'geo-fix-2026-10-04'
      FROM public.geo_elements e
      CROSS JOIN (VALUES ('جامعة الأميرة نورة'), ('جامعة الاميرة نورة')) AS v(alias)
     WHERE e.external_id IN ('RUH-UNIV-0064', 'RUH-UNIV-0072')
       AND NOT EXISTS (SELECT 1 FROM public.geo_element_aliases x
                        WHERE x.element_id = e.id AND x.alias = v.alias);
  END IF;
END $$;

COMMIT;
