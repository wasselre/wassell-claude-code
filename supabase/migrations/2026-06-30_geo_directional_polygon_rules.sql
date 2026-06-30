-- ============================================================================
-- Geometry-aware client location rules: roads (directional + within-distance)
-- and polygons (inside-area + within-distance), on top of the v1 point
-- within_radius. The deterministic Project Finder gate.
--
-- v1 (2026-06-30_client_geo_matching.sql) precompiled ONE static area per item
-- and matched ST_Contains(area, candidate). That works for within_radius (disc),
-- inside_area (polygon), within_distance (geography buffer) — all static areas.
-- It does NOT work for DIRECTIONAL rules: "north of King Salman Road" is relative
-- to ST_ClosestPoint(road, candidate), which differs per candidate — there is no
-- single precompilable area. So the compiled row now ALSO carries the road
-- geometry (ref_geom) + a direction, and the matcher evaluates the half-plane
-- per-candidate at match time.
--
-- Supported element_rule conditions (conditions inside one item AND together):
--   within_radius   {element_id, distance_m}  → disc around the POINT centroid
--   within_distance {element_id, distance_m}  → geography buffer of the FULL geom
--   inside_area     {element_id}              → ST_Contains(POLYGON, candidate)
--   north_of/south_of/east_of/west_of {element_id} → side of the LINE (per-candidate)
--
-- Mirrors api/_lib/geoMatch.ts (the tested TS twin). KEEP semantics identical.
-- ============================================================================

BEGIN;

-- 1. Compiled-row carries the directional reference geometry + direction.
ALTER TABLE public.client_pref_geometry
  ADD COLUMN IF NOT EXISTS ref_geom  geometry(Geometry, 4326),
  ADD COLUMN IF NOT EXISTS direction text;  -- 'north' | 'south' | 'east' | 'west' | NULL

-- 2. Match-time predicate helpers (pure geometry; no table access). IMMUTABLE so
--    they fold into the match query; mirror the TS predicates in geoMatch.ts.

-- Cardinal side of a line, relative to its closest point to the candidate.
CREATE OR REPLACE FUNCTION public.wassell_geo_dir_match(p_ref geometry, p_pt geometry, p_dir text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN p_ref IS NULL OR p_pt IS NULL THEN false
    WHEN p_dir = 'north' THEN ST_Y(p_pt) > ST_Y(ST_ClosestPoint(p_ref, p_pt))
    WHEN p_dir = 'south' THEN ST_Y(p_pt) < ST_Y(ST_ClosestPoint(p_ref, p_pt))
    WHEN p_dir = 'east'  THEN ST_X(p_pt) > ST_X(ST_ClosestPoint(p_ref, p_pt))
    WHEN p_dir = 'west'  THEN ST_X(p_pt) < ST_X(ST_ClosestPoint(p_ref, p_pt))
    ELSE false
  END
$$;

-- Is the candidate point inside the item's REGION? area (geom) AND/OR directional.
-- The item must carry at least one positive constraint (geom or direction); the
-- `&&` bbox test short-circuits ST_Contains so the area branch stays cheap.
CREATE OR REPLACE FUNCTION public.wassell_geo_region_contains(p_geom geometry, p_ref geometry, p_dir text, p_pt geometry)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
  SELECT p_pt IS NOT NULL
     AND (p_geom IS NOT NULL OR p_dir IS NOT NULL)
     AND (p_geom IS NULL OR (p_pt && p_geom AND ST_Contains(p_geom, p_pt)))
     AND (p_dir  IS NULL OR public.wassell_geo_dir_match(p_ref, p_pt, p_dir))
$$;

-- INCLUDE match: a pinned candidate matches by region; a point-less candidate
-- matches only by stored district-id membership (district items carry district_ids).
CREATE OR REPLACE FUNCTION public.wassell_geo_item_match(p_geom geometry, p_ref geometry, p_dir text, p_dids uuid[], p_pt geometry, p_district uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN p_pt IS NOT NULL THEN public.wassell_geo_region_contains(p_geom, p_ref, p_dir, p_pt)
    ELSE (p_district IS NOT NULL AND p_district = ANY(p_dids))
  END
$$;

-- EXCLUDE match: a stored exclude-district drops a candidate even when pinned (OR),
-- mirroring the v1 exclusion semantics; otherwise same region test.
CREATE OR REPLACE FUNCTION public.wassell_geo_exclude_match(p_geom geometry, p_ref geometry, p_dir text, p_dids uuid[], p_pt geometry, p_district uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path TO 'public' AS $$
  SELECT (p_pt IS NOT NULL AND public.wassell_geo_region_contains(p_geom, p_ref, p_dir, p_pt))
      OR (p_district IS NOT NULL AND p_district = ANY(p_dids))
$$;

-- 3. Compile: client.location_items → per-item compiled geometry rows.
CREATE OR REPLACE FUNCTION public.wassell_compile_client_geo(p_client_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_items jsonb; v_item jsonb; v_cond jsonb;
  v_kind text; v_polarity text; v_item_id text; v_rule text;
  v_district uuid; v_geom geometry; v_ref_geom geometry; v_direction text;
  v_vstatus text; v_dids uuid[];
  v_el_geom geometry; v_el_geog geography; v_el_kind text; v_el_clean geometry;
  v_el_active boolean; v_el_status text; v_el_conf numeric;
  v_usable boolean; v_buf geometry; v_dist double precision;
  v_includes int := 0; v_excludes int := 0; v_review int := 0; v_n int := 0;
  CONFIDENCE_FLOOR constant numeric := 0.5;
BEGIN
  SELECT r.data->'location_items' INTO v_items
  FROM public.records r JOIN public.models m ON m.id = r.model_id
  WHERE m.name = 'clients' AND r.id = p_client_id LIMIT 1;

  DELETE FROM public.client_pref_geometry WHERE client_id = p_client_id;

  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' THEN
    RETURN jsonb_build_object('compiled', 0, 'includes', 0, 'excludes', 0, 'needs_review', 0);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_kind := coalesce(v_item->>'kind', '');
    v_polarity := lower(coalesce(v_item->>'polarity', 'include'));
    IF v_polarity NOT IN ('include', 'exclude') THEN v_polarity := 'include'; END IF;
    v_item_id := coalesce(v_item->>'id', 'item_' || v_n::text);
    v_geom := NULL; v_ref_geom := NULL; v_direction := NULL; v_dids := '{}'; v_vstatus := 'ok';

    IF v_kind = 'district' THEN
      v_district := NULL;
      BEGIN v_district := (v_item->>'district_id')::uuid;
      EXCEPTION WHEN others THEN v_district := NULL; END;
      IF v_district IS NULL THEN
        v_vstatus := 'needs_review';
      ELSE
        SELECT ST_Multi(b.geom) INTO v_geom FROM public.district_boundaries b
        WHERE b.district_record_id = v_district AND b.is_active LIMIT 1;
        v_dids := ARRAY[v_district];
      END IF;

    ELSIF v_kind = 'element_rule' THEN
      IF jsonb_typeof(v_item->'conditions') = 'array' THEN
        FOR v_cond IN SELECT * FROM jsonb_array_elements(v_item->'conditions') LOOP
          v_rule := coalesce(v_cond->>'rule', '');
          v_el_geom := NULL; v_el_geog := NULL; v_el_kind := NULL;
          v_el_active := NULL; v_el_status := NULL; v_el_conf := NULL;
          SELECT e.geom, e.centroid_geog, e.geom_kind, e.is_active, e.review_status, e.confidence_score
            INTO v_el_geom, v_el_geog, v_el_kind, v_el_active, v_el_status, v_el_conf
          FROM public.geo_elements e
          WHERE e.external_id = (v_cond->>'element_id') LIMIT 1;

          -- Shared usability gate (missing | inactive | rejected | low confidence).
          v_usable := v_el_active IS NOT NULL
            AND coalesce(v_el_active, false)
            AND coalesce(v_el_status, 'approved') <> 'rejected'
            AND (v_el_conf IS NULL OR v_el_conf >= CONFIDENCE_FLOOR);

          -- Normalize a GEOMETRYCOLLECTION down to its dominant kind so ST_Contains /
          -- ST_Buffer / ST_ClosestPoint never hit an unsupported collection.
          v_el_clean := v_el_geom;
          IF v_el_geom IS NOT NULL AND GeometryType(v_el_geom) = 'GEOMETRYCOLLECTION' THEN
            v_el_clean := ST_CollectionExtract(v_el_geom,
              CASE v_el_kind WHEN 'polygon' THEN 3 WHEN 'linestring' THEN 2 ELSE 1 END);
          END IF;

          IF NOT v_usable THEN
            v_vstatus := 'needs_review';

          ELSIF v_rule = 'within_radius' THEN
            v_dist := public.try_numeric(v_cond->>'distance_m');
            IF v_dist IS NULL OR v_dist <= 0 OR v_el_geog IS NULL THEN
              v_vstatus := 'needs_review';
            ELSE
              v_buf := ST_Buffer(v_el_geog, v_dist, 'quad_segs=16')::geometry;
              v_geom := CASE WHEN v_geom IS NULL THEN v_buf ELSE ST_Intersection(v_geom, v_buf) END;
            END IF;

          ELSIF v_rule = 'within_distance' THEN
            v_dist := public.try_numeric(v_cond->>'distance_m');
            IF v_dist IS NULL OR v_dist <= 0 OR v_el_clean IS NULL THEN
              v_vstatus := 'needs_review';
            ELSE
              -- Buffer the FULL geometry (geography) — equivalent to ST_DWithin on
              -- the whole road/zone, NOT just the centroid.
              v_buf := ST_Buffer(v_el_clean::geography, v_dist, 'quad_segs=16')::geometry;
              v_geom := CASE WHEN v_geom IS NULL THEN v_buf ELSE ST_Intersection(v_geom, v_buf) END;
            END IF;

          ELSIF v_rule = 'inside_area' THEN
            IF v_el_clean IS NULL OR v_el_kind <> 'polygon' THEN
              v_vstatus := 'needs_review';
            ELSE
              v_geom := CASE WHEN v_geom IS NULL THEN v_el_clean ELSE ST_Intersection(v_geom, v_el_clean) END;
            END IF;

          ELSIF v_rule IN ('north_of', 'south_of', 'east_of', 'west_of') THEN
            IF v_el_clean IS NULL OR v_el_kind <> 'linestring' OR v_direction IS NOT NULL THEN
              v_vstatus := 'needs_review';  -- needs a line, and only ONE directional per item
            ELSE
              v_ref_geom := v_el_clean;
              v_direction := split_part(v_rule, '_', 1);  -- north_of → north
            END IF;

          ELSE
            v_vstatus := 'needs_review';  -- unknown rule
          END IF;
        END LOOP;
      ELSE
        v_vstatus := 'needs_review';
      END IF;

      -- An element_rule that produced no positive constraint is unprovable.
      IF v_vstatus = 'ok' AND v_geom IS NULL AND v_direction IS NULL THEN
        v_vstatus := 'needs_review';
      END IF;
      IF v_geom IS NOT NULL THEN v_geom := ST_Multi(v_geom); END IF;

    ELSE
      v_vstatus := 'needs_review';
    END IF;

    INSERT INTO public.client_pref_geometry
      (client_id, item_id, polarity, kind, geom, ref_geom, direction, district_ids, validation_status, compiled_at)
    VALUES (p_client_id, v_item_id, v_polarity, coalesce(nullif(v_kind,''),'unknown'),
            v_geom, v_ref_geom, v_direction, v_dids, v_vstatus, now())
    ON CONFLICT (client_id, item_id) DO UPDATE
      SET polarity = EXCLUDED.polarity, kind = EXCLUDED.kind, geom = EXCLUDED.geom,
          ref_geom = EXCLUDED.ref_geom, direction = EXCLUDED.direction,
          district_ids = EXCLUDED.district_ids, validation_status = EXCLUDED.validation_status,
          compiled_at = now();

    v_n := v_n + 1;
    IF v_vstatus = 'needs_review' THEN v_review := v_review + 1;
    ELSIF v_polarity = 'include' THEN v_includes := v_includes + 1;
    ELSE v_excludes := v_excludes + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object('compiled', v_n, 'includes', v_includes, 'excludes', v_excludes, 'needs_review', v_review);
END;
$function$;

-- 4. Match: compiled rows + candidate points → matched records (union/dedup/exclude).
--    Per-item predicate so directional (per-candidate) rules compose with area rules.
CREATE OR REPLACE FUNCTION public.wassell_geo_match(p_client_id uuid)
 RETURNS TABLE(record_id uuid, matched_item_ids text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH inc AS (
    SELECT item_id, geom, ref_geom, direction, district_ids FROM public.client_pref_geometry
    WHERE client_id = p_client_id AND polarity = 'include' AND validation_status = 'ok'
  ),
  exc AS (
    SELECT geom, ref_geom, direction, district_ids FROM public.client_pref_geometry
    WHERE client_id = p_client_id AND polarity = 'exclude' AND validation_status = 'ok'
  ),
  cand AS (
    SELECT record_id, geom AS pt, district_id FROM public.project_points WHERE is_active
    UNION ALL
    SELECT record_id, geom, district_id FROM public.listing_points WHERE is_active
  )
  SELECT c.record_id,
         (
           SELECT coalesce(array_agg(i.item_id), '{}'::text[]) FROM inc i
           WHERE public.wassell_geo_item_match(i.geom, i.ref_geom, i.direction, i.district_ids, c.pt, c.district_id)
         ) AS matched_item_ids
  FROM cand c
  WHERE EXISTS (
          SELECT 1 FROM inc i
          WHERE public.wassell_geo_item_match(i.geom, i.ref_geom, i.direction, i.district_ids, c.pt, c.district_id)
        )
    AND NOT EXISTS (
          SELECT 1 FROM exc e
          WHERE public.wassell_geo_exclude_match(e.geom, e.ref_geom, e.direction, e.district_ids, c.pt, c.district_id)
        )
$function$;

-- 5. Search resolver returns geom_kind so the client UI can branch the rule picker.
--    (DROP needed: adding an OUT column changes the return row type.)
DROP FUNCTION IF EXISTS public.wassell_search_geo_elements(text, text, text, text, integer, boolean);
CREATE OR REPLACE FUNCTION public.wassell_search_geo_elements(
  p_q text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_type text DEFAULT NULL::text,
  p_city text DEFAULT NULL::text, p_limit integer DEFAULT 30, p_include_unapproved boolean DEFAULT false)
 RETURNS TABLE(external_id text, name_ar text, name_en text, display_name text, category text, type text,
               geom_kind text, city text, latitude double precision, longitude double precision,
               confidence_score numeric, is_verified boolean, is_approximate boolean, review_status text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH q AS (SELECT lower(btrim(coalesce(p_q, ''))) AS term)
  SELECT DISTINCT ON (e.external_id)
    e.external_id, e.name_ar, e.name_en, e.display_name,
    e.category, e.type, e.geom_kind, e.city,
    e.latitude, e.longitude, e.confidence_score, e.is_verified, e.is_approximate, e.review_status
  FROM public.geo_elements e, q
  WHERE e.external_id IS NOT NULL
    AND e.is_active
    AND (p_include_unapproved OR (e.is_searchable AND e.review_status = 'approved'))
    AND (p_category IS NULL OR e.category = p_category)
    AND (p_type     IS NULL OR e.type = p_type)
    AND (p_city     IS NULL OR e.city ILIKE p_city)
    AND (
      q.term = '' OR
      e.name_ar ILIKE '%' || q.term || '%' OR
      e.name_en ILIKE '%' || q.term || '%' OR
      e.display_name ILIKE '%' || q.term || '%' OR
      EXISTS (SELECT 1 FROM public.geo_element_aliases a
              WHERE a.element_id = e.id AND a.alias_norm ILIKE '%' || q.term || '%')
    )
  ORDER BY e.external_id, e.is_verified DESC, e.confidence_score DESC NULLS LAST
  LIMIT greatest(1, least(coalesce(p_limit, 30), 100))
$function$;

-- 6. Lock down the new helpers (Supabase auto-grants anon; mirror the v1 posture).
REVOKE EXECUTE ON FUNCTION public.wassell_geo_dir_match(geometry, geometry, text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.wassell_geo_region_contains(geometry, geometry, text, geometry) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.wassell_geo_item_match(geometry, geometry, text, uuid[], geometry, uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.wassell_geo_exclude_match(geometry, geometry, text, uuid[], geometry, uuid) FROM anon, public;

COMMIT;
