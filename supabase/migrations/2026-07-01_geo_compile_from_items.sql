-- ============================================================================
-- Compile the geo gate from a SUPPLIED location_items array (the draft the rep is
-- editing), not only the saved client record.
--
-- BUG this fixes: the Project Finder's geo gate always compiled from the SAVED
-- client record (wassell_compile_client_geo(client_id)), so an unsaved rule edit —
-- e.g. switching "north of King Salman Road" to "south of" — was ignored: the finder
-- re-read the saved north_of and returned NORTH results while the chip showed south.
--
-- Now the finder can pass the current draft location_items; wassell_compile_geo_items
-- compiles from THOSE (same logic, same writes to client_pref_geometry keyed by
-- client_id, so wassell_geo_match is unchanged). wassell_compile_client_geo becomes a
-- thin wrapper that reads the saved items and delegates — every existing caller keeps
-- working. Mirrors the split in api/_lib/geoMatch.ts (compile is item-driven).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_compile_geo_items(p_client_id uuid, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_items jsonb := p_items; v_item jsonb; v_cond jsonb;
  v_kind text; v_polarity text; v_item_id text; v_rule text;
  v_district uuid; v_geom geometry; v_ref_geom geometry; v_direction text;
  v_vstatus text; v_dids uuid[];
  v_el_geom geometry; v_el_geog geography; v_el_kind text; v_el_clean geometry;
  v_el_active boolean; v_el_status text; v_el_conf numeric;
  v_usable boolean; v_buf geometry; v_dist double precision;
  v_includes int := 0; v_excludes int := 0; v_review int := 0; v_n int := 0;
  CONFIDENCE_FLOOR constant numeric := 0.5;
BEGIN
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

          v_usable := v_el_active IS NOT NULL
            AND coalesce(v_el_active, false)
            AND coalesce(v_el_status, 'approved') <> 'rejected'
            AND (v_el_conf IS NULL OR v_el_conf >= CONFIDENCE_FLOOR);

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
              v_vstatus := 'needs_review';
            ELSE
              v_ref_geom := v_el_clean;
              v_direction := split_part(v_rule, '_', 1);
            END IF;
          ELSE
            v_vstatus := 'needs_review';
          END IF;
        END LOOP;
      ELSE
        v_vstatus := 'needs_review';
      END IF;

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

-- Thin wrapper: read the SAVED client's location_items and delegate.
CREATE OR REPLACE FUNCTION public.wassell_compile_client_geo(p_client_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_items jsonb;
BEGIN
  SELECT r.data->'location_items' INTO v_items
  FROM public.records r JOIN public.models m ON m.id = r.model_id
  WHERE m.name = 'clients' AND r.id = p_client_id LIMIT 1;
  RETURN public.wassell_compile_geo_items(p_client_id, v_items);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.wassell_compile_geo_items(uuid, jsonb) FROM anon, public;

COMMIT;
