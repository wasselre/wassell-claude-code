-- ============================================================================
-- Geo-intelligence storage/runtime layer for geo_elements (v1 anchors)
-- ============================================================================
-- Evolves the v1 geo_elements table into the runtime store for the gathered
-- Riyadh geo-intelligence dataset (landmarks, roads, hospitals, airports,
-- business zones, parks, metro stations, malls, zones, transport nodes — ~725
-- anchors). The deterministic matcher (api/_lib/geoMatch.ts + the SQL twin)
-- consumes it; the anchors themselves are NEVER stored in geoMatch.ts (which
-- stays pure matching logic). Raw uploaded files live under data/source/geo/.
--
-- Adds, on geo_elements:
--   external_id      — STABLE business id from the dataset; element rules in
--                      clients.data.location_items reference THIS (not the uuid).
--   category, type   — dataset taxonomy (high-level + sub).
--   city             — plain city label (e.g. 'Riyadh') for resolver filtering.
--   latitude/longitude — the canonical point coords (display + audit).
--   centroid_geog    — geography(Point,4326): the canonical matching point used
--                      by within_radius (ST_Buffer on geography = metre-accurate).
--   raw              — the full source row (provenance, never lossy).
--   review_status    — 'approved' | 'pending' | 'rejected' (curation gate).
--   is_searchable    — resolver default filter.
--   confidence_score — 0..1 import confidence.
--   is_verified / is_approximate — display + curation flags.
-- geom geometry(Geometry,4326) (full geometry) is preserved as-is.
--
-- Plus geo_element_aliases (AR/EN/search aliases), GiST on geom + centroid_geog,
-- and btree on city/category/type.
--
-- Finally rewires wassell_compile_client_geo: within_radius resolves
-- element_rule.conditions[].element_id from geo_elements.external_id and buffers
-- centroid_geog. A missing / inactive / rejected / low-confidence / invalid
-- element compiles to needs_review (skipped in matching, never silently dropped).
-- Kept SEMANTICALLY IDENTICAL to api/_lib/geoMatch.ts (compileItem + elementUsable).
-- ============================================================================

BEGIN;

-- ── 1. Evolve geo_elements (idempotent) ─────────────────────────────────────
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS external_id      text;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS category         text;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS type             text;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS city             text;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS latitude         double precision;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS longitude        double precision;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS centroid_geog    geography(Point, 4326);
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS raw              jsonb;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS review_status    text NOT NULL DEFAULT 'approved';
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS is_searchable    boolean NOT NULL DEFAULT true;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS confidence_score numeric;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS is_verified      boolean NOT NULL DEFAULT false;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS is_approximate   boolean NOT NULL DEFAULT false;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS source_url       text;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS source_type      text;
ALTER TABLE public.geo_elements ADD COLUMN IF NOT EXISTS notes            text;

-- external_id is the stable handle element rules reference. Partial-unique so the
-- importer can upsert ON CONFLICT (external_id) while legacy/NULL rows coexist.
CREATE UNIQUE INDEX IF NOT EXISTS geo_elements_external_id_uidx
  ON public.geo_elements (external_id) WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS geo_elements_centroid_gix ON public.geo_elements USING gist (centroid_geog);
CREATE INDEX IF NOT EXISTS geo_elements_city2_idx    ON public.geo_elements (city);
CREATE INDEX IF NOT EXISTS geo_elements_category_idx ON public.geo_elements (category);
CREATE INDEX IF NOT EXISTS geo_elements_type_idx     ON public.geo_elements (type);
-- (geo_elements_geom_gix already exists from the v1 migration.)

-- Backfill centroid_geog for any existing row that has a geom but no centroid
-- (ST_PointOnSurface is robust for polygons; for a point it's the point itself).
UPDATE public.geo_elements
SET centroid_geog = ST_PointOnSurface(geom)::geography
WHERE centroid_geog IS NULL AND geom IS NOT NULL;

-- Reconcile the v1 manually-seeded KAFD point into the new shape so the rewired
-- matcher has a usable, named anchor immediately (external_id = 'kafd').
UPDATE public.geo_elements
SET external_id = 'kafd', category = 'business_zone', type = 'financial_district',
    city = 'Riyadh', latitude = 24.7625, longitude = 46.6406,
    review_status = 'approved', is_searchable = true, confidence_score = 1.0,
    is_verified = true, is_approximate = false
WHERE name_en = 'KAFD' AND external_id IS NULL;

-- ── 2. geo_element_aliases — AR/EN/search aliases ───────────────────────────
CREATE TABLE IF NOT EXISTS public.geo_element_aliases (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  element_id   uuid NOT NULL REFERENCES public.geo_elements(id) ON DELETE CASCADE,
  external_id  text,                 -- denormalized (importer convenience)
  alias        text NOT NULL,
  alias_norm   text NOT NULL,        -- lower(btrim(alias)) for ILIKE search
  lang         text,                 -- 'ar' | 'en' | null
  source       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_element_aliases_element_idx ON public.geo_element_aliases (element_id);
CREATE INDEX IF NOT EXISTS geo_element_aliases_norm_idx    ON public.geo_element_aliases (alias_norm text_pattern_ops);
CREATE UNIQUE INDEX IF NOT EXISTS geo_element_aliases_uniq  ON public.geo_element_aliases (element_id, alias_norm, coalesce(lang,''));

ALTER TABLE public.geo_element_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geo_element_aliases_read ON public.geo_element_aliases;
CREATE POLICY geo_element_aliases_read ON public.geo_element_aliases FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.geo_element_aliases TO authenticated;

-- ── 3. Rewire wassell_compile_client_geo: element_id → external_id, buffer the
--       canonical centroid_geog, fail-closed on bad anchors. ─────────────────
--    needs_review when the element is: missing | inactive | review_status
--    'rejected' | confidence_score < 0.5 (CONFIDENCE_FLOOR) | no centroid.
--    KEEP SEMANTICALLY IDENTICAL to api/_lib/geoMatch.ts (elementUsable).
CREATE OR REPLACE FUNCTION public.wassell_compile_client_geo(p_client_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items jsonb; v_item jsonb; v_cond jsonb;
  v_kind text; v_polarity text; v_item_id text;
  v_district uuid; v_geom geometry; v_buf geometry; v_vstatus text; v_dids uuid[];
  v_el_geog geography; v_el_active boolean; v_el_status text; v_el_conf numeric;
  v_dist double precision;
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
    v_geom := NULL; v_dids := '{}'; v_vstatus := 'ok';

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
          IF coalesce(v_cond->>'rule', '') = 'within_radius' THEN
            v_dist := public.try_numeric(v_cond->>'distance_m');
            -- Resolve the anchor by its STABLE external_id (not the uuid).
            v_el_geog := NULL; v_el_active := NULL; v_el_status := NULL; v_el_conf := NULL;
            SELECT e.centroid_geog, e.is_active, e.review_status, e.confidence_score
              INTO v_el_geog, v_el_active, v_el_status, v_el_conf
            FROM public.geo_elements e
            WHERE e.external_id = (v_cond->>'element_id') LIMIT 1;

            IF v_dist IS NULL OR v_dist <= 0
               OR v_el_geog IS NULL                       -- missing / no canonical point
               OR coalesce(v_el_active, false) = false    -- inactive
               OR coalesce(v_el_status, 'approved') = 'rejected'
               OR (v_el_conf IS NOT NULL AND v_el_conf < CONFIDENCE_FLOOR)  -- low confidence
            THEN
              v_vstatus := 'needs_review';
            ELSE
              -- centroid_geog is geography → ST_Buffer measures metres directly.
              v_buf := ST_Buffer(v_el_geog, v_dist, 'quad_segs=16')::geometry;
              v_geom := CASE WHEN v_geom IS NULL THEN v_buf ELSE ST_Intersection(v_geom, v_buf) END;
            END IF;
          ELSE
            v_vstatus := 'needs_review';  -- unsupported rule in v1
          END IF;
        END LOOP;
      ELSE
        v_vstatus := 'needs_review';
      END IF;
      IF v_geom IS NOT NULL THEN v_geom := ST_Multi(v_geom); END IF;

    ELSE
      v_vstatus := 'needs_review';  -- unknown kind
    END IF;

    INSERT INTO public.client_pref_geometry
      (client_id, item_id, polarity, kind, geom, district_ids, validation_status, compiled_at)
    VALUES (p_client_id, v_item_id, v_polarity, coalesce(nullif(v_kind,''),'unknown'),
            v_geom, v_dids, v_vstatus, now())
    ON CONFLICT (client_id, item_id) DO UPDATE
      SET polarity = EXCLUDED.polarity, kind = EXCLUDED.kind, geom = EXCLUDED.geom,
          district_ids = EXCLUDED.district_ids, validation_status = EXCLUDED.validation_status,
          compiled_at = now();

    v_n := v_n + 1;
    IF v_vstatus = 'needs_review' THEN v_review := v_review + 1;
    ELSIF v_polarity = 'include' THEN v_includes := v_includes + 1;
    ELSE v_excludes := v_excludes + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object('compiled', v_n, 'includes', v_includes, 'excludes', v_excludes, 'needs_review', v_review);
END;
$$;
GRANT EXECUTE ON FUNCTION public.wassell_compile_client_geo(uuid) TO authenticated, service_role;

-- ── 4. Resolver search RPC for the UI (districts OR geo elements, one section) ─
--    Search across name_ar / name_en / aliases / category / type / city.
--    Returns only active + searchable + approved by default (p_include_unapproved
--    opens it for an admin curation view). SECURITY INVOKER — geo_elements RLS
--    already allows authenticated SELECT.
CREATE OR REPLACE FUNCTION public.wassell_search_geo_elements(
  p_q text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_type text DEFAULT NULL,
  p_city text DEFAULT NULL,
  p_limit int DEFAULT 30,
  p_include_unapproved boolean DEFAULT false
)
RETURNS TABLE(
  external_id text, name_ar text, name_en text, display_name text,
  category text, type text, city text,
  latitude double precision, longitude double precision,
  confidence_score numeric, is_verified boolean, is_approximate boolean,
  review_status text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH q AS (SELECT lower(btrim(coalesce(p_q, ''))) AS term)
  SELECT DISTINCT ON (e.external_id)
    e.external_id, e.name_ar, e.name_en, e.display_name,
    e.category, e.type, e.city,
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
$$;
GRANT EXECUTE ON FUNCTION public.wassell_search_geo_elements(text, text, text, text, int, boolean)
  TO authenticated, service_role;

COMMIT;
