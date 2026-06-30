-- ============================================================================
-- Geo Elements admin module — list / detail / update / alias RPCs
-- ============================================================================
-- Backs the admin management UI (/settings/geo-elements). These functions are
-- service-role ONLY; the /api/geo-elements-admin endpoint checks wassell_is_admin
-- on the caller's JWT first, then calls them via the service client (same posture
-- as the Market Intelligence admin endpoints).
--
-- This is a MANAGEMENT surface for data already in geo_elements. It does NOT
-- change matching semantics, geoMatch.ts, or the compile/match RPCs, and the
-- client resolver wassell_search_geo_elements / /api/geo-elements is untouched.
-- Geometry is read-only here (no geometry editing in v1).
-- ============================================================================

BEGIN;

-- ── List with filters + total (server-side pagination) ──────────────────────
CREATE OR REPLACE FUNCTION public.wassell_admin_list_geo_elements(
  p_q text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_type text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_geom_kind text DEFAULT NULL,
  p_review_status text DEFAULT NULL,
  p_is_verified boolean DEFAULT NULL,
  p_is_approximate boolean DEFAULT NULL,
  p_is_active boolean DEFAULT NULL,
  p_is_searchable boolean DEFAULT NULL,
  p_conf_min numeric DEFAULT NULL,
  p_conf_max numeric DEFAULT NULL,
  p_low_confidence boolean DEFAULT NULL,
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH f AS (
    SELECT e.* FROM public.geo_elements e
    WHERE e.external_id IS NOT NULL
      AND (p_category IS NULL OR e.category = p_category)
      AND (p_type IS NULL OR e.type = p_type)
      AND (p_city IS NULL OR e.city ILIKE p_city)
      AND (p_geom_kind IS NULL OR e.geom_kind = p_geom_kind)
      AND (p_review_status IS NULL OR e.review_status = p_review_status)
      AND (p_is_verified IS NULL OR e.is_verified = p_is_verified)
      AND (p_is_approximate IS NULL OR e.is_approximate = p_is_approximate)
      AND (p_is_active IS NULL OR e.is_active = p_is_active)
      AND (p_is_searchable IS NULL OR e.is_searchable = p_is_searchable)
      AND (p_conf_min IS NULL OR e.confidence_score >= p_conf_min)
      AND (p_conf_max IS NULL OR e.confidence_score <= p_conf_max)
      AND (NOT coalesce(p_low_confidence, false)
           OR (e.confidence_score IS NOT NULL AND e.confidence_score < 0.5))
      AND (
        nullif(btrim(coalesce(p_q,'')),'') IS NULL
        OR e.name_ar ILIKE '%'||btrim(p_q)||'%'
        OR e.name_en ILIKE '%'||btrim(p_q)||'%'
        OR e.display_name ILIKE '%'||btrim(p_q)||'%'
        OR e.external_id ILIKE '%'||btrim(p_q)||'%'
        OR EXISTS (SELECT 1 FROM public.geo_element_aliases a
                   WHERE a.element_id = e.id AND a.alias_norm ILIKE '%'||lower(btrim(p_q))||'%')
      )
  ),
  page AS (
    SELECT jsonb_build_object(
      'external_id', f.external_id, 'name_ar', f.name_ar, 'name_en', f.name_en,
      'display_name', f.display_name, 'category', f.category, 'type', f.type, 'city', f.city,
      'geometry_type', f.geom_kind, 'confidence_score', f.confidence_score,
      'is_verified', f.is_verified, 'is_approximate', f.is_approximate,
      'review_status', f.review_status, 'is_active', f.is_active, 'is_searchable', f.is_searchable,
      'source_type', f.source_type, 'updated_at', f.updated_at, 'created_at', f.created_at
    ) AS r
    FROM f
    ORDER BY f.category, f.name_en NULLS LAST, f.external_id
    LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
    OFFSET greatest(0, coalesce(p_offset, 0))
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM f),
    'rows',  (SELECT coalesce(jsonb_agg(r), '[]'::jsonb) FROM page)
  );
$$;

-- ── Filter facets (distinct values for the dropdowns) ───────────────────────
CREATE OR REPLACE FUNCTION public.wassell_admin_geo_facets()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'categories',     (SELECT coalesce(jsonb_agg(DISTINCT category ORDER BY category) FILTER (WHERE category IS NOT NULL), '[]') FROM public.geo_elements WHERE external_id IS NOT NULL),
    'types',          (SELECT coalesce(jsonb_agg(DISTINCT type ORDER BY type) FILTER (WHERE type IS NOT NULL), '[]') FROM public.geo_elements WHERE external_id IS NOT NULL),
    'cities',         (SELECT coalesce(jsonb_agg(DISTINCT city ORDER BY city) FILTER (WHERE city IS NOT NULL), '[]') FROM public.geo_elements WHERE external_id IS NOT NULL),
    'geometry_types', (SELECT coalesce(jsonb_agg(DISTINCT geom_kind ORDER BY geom_kind) FILTER (WHERE geom_kind IS NOT NULL), '[]') FROM public.geo_elements WHERE external_id IS NOT NULL),
    'review_statuses',(SELECT coalesce(jsonb_agg(DISTINCT review_status ORDER BY review_status) FILTER (WHERE review_status IS NOT NULL), '[]') FROM public.geo_elements WHERE external_id IS NOT NULL),
    'source_types',   (SELECT coalesce(jsonb_agg(DISTINCT source_type ORDER BY source_type) FILTER (WHERE source_type IS NOT NULL), '[]') FROM public.geo_elements WHERE external_id IS NOT NULL),
    'total',          (SELECT count(*) FROM public.geo_elements WHERE external_id IS NOT NULL)
  );
$$;

-- ── Full detail (all fields + geometry summary + geojson + aliases) ─────────
CREATE OR REPLACE FUNCTION public.wassell_admin_get_geo_element(p_external_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'external_id', e.external_id, 'name_ar', e.name_ar, 'name_en', e.name_en, 'display_name', e.display_name,
    'category', e.category, 'type', e.type, 'city', e.city, 'region_id', e.region_id,
    'geometry_type', e.geom_kind, 'latitude', e.latitude, 'longitude', e.longitude,
    'confidence_score', e.confidence_score, 'is_verified', e.is_verified, 'is_approximate', e.is_approximate,
    'review_status', e.review_status, 'is_active', e.is_active, 'is_searchable', e.is_searchable,
    'source_type', e.source_type, 'source_url', e.source_url, 'notes', e.notes,
    'created_at', e.created_at, 'updated_at', e.updated_at,
    'geometry_summary', jsonb_build_object(
      'postgis_type', ST_GeometryType(e.geom),
      'n_points', ST_NPoints(e.geom),
      'n_geometries', ST_NumGeometries(e.geom),
      'bbox', ST_AsText(ST_Envelope(e.geom))
    ),
    'geojson', ST_AsGeoJSON(e.geom)::jsonb,
    'raw', e.raw,
    'aliases', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'alias', a.alias, 'lang', a.lang) ORDER BY a.lang, a.alias), '[]')
                FROM public.geo_element_aliases a WHERE a.element_id = e.id)
  )
  FROM public.geo_elements e WHERE e.external_id = p_external_id LIMIT 1;
$$;

-- ── Update whitelisted fields (NO geometry editing) ─────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_admin_update_geo_element(p_external_id text, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_rs text;
BEGIN
  IF p_patch ? 'review_status' THEN
    v_rs := p_patch->>'review_status';
    IF v_rs NOT IN ('approved','needs_review','rejected') THEN
      RAISE EXCEPTION 'invalid review_status: %', v_rs;
    END IF;
  END IF;

  UPDATE public.geo_elements e SET
    review_status  = CASE WHEN p_patch ? 'review_status' THEN p_patch->>'review_status' ELSE e.review_status END,
    is_active      = CASE WHEN p_patch ? 'is_active'     THEN (p_patch->>'is_active')::boolean ELSE e.is_active END,
    is_searchable  = CASE WHEN p_patch ? 'is_searchable' THEN (p_patch->>'is_searchable')::boolean ELSE e.is_searchable END,
    name_ar        = CASE WHEN p_patch ? 'name_ar'       THEN nullif(btrim(p_patch->>'name_ar'),'') ELSE e.name_ar END,
    name_en        = CASE WHEN p_patch ? 'name_en'       THEN nullif(btrim(p_patch->>'name_en'),'') ELSE e.name_en END,
    notes          = CASE WHEN p_patch ? 'notes'         THEN nullif(btrim(p_patch->>'notes'),'') ELSE e.notes END,
    display_name   = CASE WHEN (p_patch ? 'name_en') OR (p_patch ? 'name_ar')
                          THEN coalesce(
                                 nullif(btrim(coalesce(p_patch->>'name_en', e.name_en)),''),
                                 nullif(btrim(coalesce(p_patch->>'name_ar', e.name_ar)),''),
                                 e.external_id)
                          ELSE e.display_name END,
    updated_at     = now()
  WHERE e.external_id = p_external_id;

  IF NOT FOUND THEN RAISE EXCEPTION 'geo_element not found: %', p_external_id; END IF;
  RETURN public.wassell_admin_get_geo_element(p_external_id);
END;
$$;

-- ── Alias add / remove (geo_element_aliases) ────────────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_admin_add_geo_alias(p_external_id text, p_alias text, p_lang text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_eid uuid; v_alias text := nullif(btrim(coalesce(p_alias,'')),'');
BEGIN
  IF v_alias IS NULL THEN RAISE EXCEPTION 'alias is required'; END IF;
  SELECT id INTO v_eid FROM public.geo_elements WHERE external_id = p_external_id LIMIT 1;
  IF v_eid IS NULL THEN RAISE EXCEPTION 'geo_element not found: %', p_external_id; END IF;
  INSERT INTO public.geo_element_aliases (element_id, external_id, alias, alias_norm, lang, source)
  VALUES (v_eid, p_external_id, v_alias, lower(v_alias), nullif(btrim(coalesce(p_lang,'')),''), 'admin')
  ON CONFLICT (element_id, alias_norm, coalesce(lang,'')) DO NOTHING;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'alias', a.alias, 'lang', a.lang) ORDER BY a.lang, a.alias), '[]')
          FROM public.geo_element_aliases a WHERE a.element_id = v_eid);
END;
$$;

CREATE OR REPLACE FUNCTION public.wassell_admin_remove_geo_alias(p_alias_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_eid uuid;
BEGIN
  SELECT element_id INTO v_eid FROM public.geo_element_aliases WHERE id = p_alias_id;
  IF v_eid IS NULL THEN RETURN '[]'::jsonb; END IF;
  DELETE FROM public.geo_element_aliases WHERE id = p_alias_id;
  RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'alias', a.alias, 'lang', a.lang) ORDER BY a.lang, a.alias), '[]')
          FROM public.geo_element_aliases a WHERE a.element_id = v_eid);
END;
$$;

-- ── Lock all of these to service_role only (the API gates on wassell_is_admin) ─
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.wassell_admin_list_geo_elements(text,text,text,text,text,text,boolean,boolean,boolean,boolean,numeric,numeric,boolean,int,int)',
    'public.wassell_admin_geo_facets()',
    'public.wassell_admin_get_geo_element(text)',
    'public.wassell_admin_update_geo_element(text,jsonb)',
    'public.wassell_admin_add_geo_alias(text,text,text)',
    'public.wassell_admin_remove_geo_alias(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated;', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role;', fn);
  END LOOP;
END $$;

COMMIT;
