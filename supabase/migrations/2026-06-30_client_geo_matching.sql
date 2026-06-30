-- ============================================================================
-- Client location matching (v1) — deterministic, PostGIS, no AI
-- ============================================================================
-- Clients can express location preferences as a list of items on
-- `clients.data.location_items` (JSONB). v1 supports exactly THREE item kinds:
--
--   • include district   — { kind:'district', polarity:'include', district_id }
--   • exclude district    — { kind:'district', polarity:'exclude', district_id }
--   • within_radius        — { kind:'element_rule', polarity:'include'|'exclude',
--                              conditions:[{ rule:'within_radius', element_id, distance_m }] }
--
-- Mental model: every item compiles to ONE geometry. Multiple items combine as
-- OR (union); excludes subtract from that union; a candidate (project / listing)
-- matches when its point is inside the union (or, when it has no pin, when its
-- stored district id is in an include district). The Project Finder uses the
-- resulting id-set to GATE candidates BEFORE the existing deterministic scorer —
-- it never changes scoreProject's weights.
--
-- NOT in v1 (deliberately): road directional rules (north/south/east/west_of),
-- inside/outside_polygon, between_elements, compound multi-condition AND, and any
-- non-point geo_element. The schema is shaped so those land later without a rewrite.
--
-- Artifacts:
--   1. geo_elements           — catalog of point landmarks (general geom column).
--   2. project_points         — geometry(Point,4326) per all_projects record.
--   3. listing_points         — geometry(Point,4326) per market_listings record.
--   4. records trigger        — keeps the two point tables in sync on every write.
--   5. client_pref_geometry   — compiled per-item geometry (the "computed area").
--   6. wassell_compile_client_geo(client) — items → client_pref_geometry rows.
--   7. wassell_geo_match(client)          — compiled geometry → matched record ids.
--
-- All point-in-polygon / radius work runs on SRID-4326 geometry; radii are
-- measured in metres via the `geography` cast (great-circle accurate). PostGIS,
-- GiST indexes, and `public.try_numeric` already exist.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. geo_elements — point landmarks (v1). geom is a general column so lines /
--    polygons can be added later; v1 only writes/uses POINT geometries.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.geo_elements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  element_type       text NOT NULL,                         -- landmark|mall|hospital|airport|university|metro_station|park|custom
  geom_kind          text NOT NULL DEFAULT 'point',         -- v1: always 'point'
  name_ar            text,
  name_en            text,
  display_name       text,
  city_id            text,                                  -- districts.city_id scope (nullable)
  region_id          text,
  geom               geometry(Geometry, 4326) NOT NULL,     -- v1: Point
  -- A point landmark is geometrically unambiguous, so v1 elements are usable
  -- immediately. The 'needs_review' machinery exists for the LATER road-directional
  -- rules whose computed side-polygon must be admin-approved before matching.
  validation_status  text NOT NULL DEFAULT 'ok',            -- 'ok' | 'needs_review'
  source             text,
  is_active          boolean NOT NULL DEFAULT true,
  created_by_user_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_elements_geom_gix ON public.geo_elements USING gist (geom);
CREATE INDEX IF NOT EXISTS geo_elements_city_idx ON public.geo_elements (city_id, element_type, is_active);

-- Shared, non-sensitive reference data: readable by every authenticated user
-- (the preference wizard must list elements for every role). Writes are
-- service-role / admin only (no INSERT/UPDATE policy → blocked for authenticated).
ALTER TABLE public.geo_elements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS geo_elements_read ON public.geo_elements;
CREATE POLICY geo_elements_read ON public.geo_elements FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.geo_elements TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 2 + 3. Candidate point tables. `records` has no geom column (JSONB), so we
--        project each candidate's pin into a GiST-indexed point table. district_id
--        is the stored districts-record id, used to match POINT-LESS candidates
--        (projects with no pin) against include/exclude DISTRICT items.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_points (
  record_id   uuid PRIMARY KEY,
  geom        geometry(Point, 4326),   -- NULL when the project has no pin
  district_id uuid,                    -- stored location.district (record id)
  is_active   boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_points_geom_gix ON public.project_points USING gist (geom);
CREATE INDEX IF NOT EXISTS project_points_district_idx ON public.project_points (district_id);

CREATE TABLE IF NOT EXISTS public.listing_points (
  record_id   uuid PRIMARY KEY,
  geom        geometry(Point, 4326),
  district_id uuid,
  is_active   boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS listing_points_geom_gix ON public.listing_points USING gist (geom);
CREATE INDEX IF NOT EXISTS listing_points_district_idx ON public.listing_points (district_id);

-- These mirror RLS-protected `records`. The matcher reads them via a SECURITY
-- DEFINER function, and the Project Finder re-filters every returned id through
-- the caller's JWT-scoped record load, so a returned id the caller can't see is
-- harmless (it never enters the finder's candidate pool). Lock direct access.
ALTER TABLE public.project_points ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_points ENABLE ROW LEVEL SECURITY;

-- Helper: safe (lng,lat) → geometry(Point,4326). Returns NULL when either coord
-- is missing / non-numeric / out of range, so one bad row never breaks a backfill.
CREATE OR REPLACE FUNCTION public._geo_point_from_data(p_data jsonb)
RETURNS geometry
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN lat IS NOT NULL AND lng IS NOT NULL
         AND lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180
    THEN ST_SetSRID(ST_MakePoint(lng::double precision, lat::double precision), 4326)
  END
  FROM (
    SELECT public.try_numeric(p_data->>'latitude')  AS lat,
           public.try_numeric(p_data->>'longitude') AS lng
  ) c
$$;

-- Helper: stored district id (uuid) from data.location.district, NULL when absent
-- or not a uuid (never throws on bad text).
CREATE OR REPLACE FUNCTION public._geo_district_from_data(p_data jsonb)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN (p_data->'location'->>'district') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN (p_data->'location'->>'district')::uuid
  END
$$;

-- ── Backfill from existing records ──────────────────────────────────────────
INSERT INTO public.project_points (record_id, geom, district_id, is_active, updated_at)
SELECT r.id,
       public._geo_point_from_data(r.data),
       public._geo_district_from_data(r.data),
       coalesce((r.data->>'is_active')::boolean, true),
       now()
FROM public.records r
JOIN public.models m ON m.id = r.model_id
WHERE m.name = 'all_projects'
ON CONFLICT (record_id) DO UPDATE
  SET geom = EXCLUDED.geom, district_id = EXCLUDED.district_id,
      is_active = EXCLUDED.is_active, updated_at = now();

INSERT INTO public.listing_points (record_id, geom, district_id, is_active, updated_at)
SELECT r.id,
       public._geo_point_from_data(r.data),
       public._geo_district_from_data(r.data),
       coalesce((r.data->>'is_active')::boolean, true),
       now()
FROM public.records r
JOIN public.models m ON m.id = r.model_id
WHERE m.name = 'market_listings'
ON CONFLICT (record_id) DO UPDATE
  SET geom = EXCLUDED.geom, district_id = EXCLUDED.district_id,
      is_active = EXCLUDED.is_active, updated_at = now();

-- ────────────────────────────────────────────────────────────────────────────
-- 4. Keep the point tables in sync. AFTER trigger on `records`; routes by model
--    name (only all_projects / market_listings act — every other write is a fast
--    no-op). SECURITY DEFINER so it can write the point tables regardless of the
--    caller's RLS. Runs with a fixed search_path (records writes go through RPCs
--    with a restricted search_path — see the records-trigger search_path note).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._sync_geo_point()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_projects_model uuid;
  v_listings_model uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.project_points WHERE record_id = OLD.id;
    DELETE FROM public.listing_points WHERE record_id = OLD.id;
    RETURN OLD;
  END IF;

  SELECT id INTO v_projects_model FROM public.models WHERE name = 'all_projects' LIMIT 1;
  SELECT id INTO v_listings_model FROM public.models WHERE name = 'market_listings' LIMIT 1;

  IF NEW.model_id = v_projects_model THEN
    INSERT INTO public.project_points (record_id, geom, district_id, is_active, updated_at)
    VALUES (NEW.id, public._geo_point_from_data(NEW.data), public._geo_district_from_data(NEW.data),
            coalesce((NEW.data->>'is_active')::boolean, true), now())
    ON CONFLICT (record_id) DO UPDATE
      SET geom = EXCLUDED.geom, district_id = EXCLUDED.district_id,
          is_active = EXCLUDED.is_active, updated_at = now();
  ELSIF NEW.model_id = v_listings_model THEN
    INSERT INTO public.listing_points (record_id, geom, district_id, is_active, updated_at)
    VALUES (NEW.id, public._geo_point_from_data(NEW.data), public._geo_district_from_data(NEW.data),
            coalesce((NEW.data->>'is_active')::boolean, true), now())
    ON CONFLICT (record_id) DO UPDATE
      SET geom = EXCLUDED.geom, district_id = EXCLUDED.district_id,
          is_active = EXCLUDED.is_active, updated_at = now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS records_sync_geo_point ON public.records;
CREATE TRIGGER records_sync_geo_point
  AFTER INSERT OR UPDATE OR DELETE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public._sync_geo_point();

-- ────────────────────────────────────────────────────────────────────────────
-- 5. client_pref_geometry — the compiled per-item area. ONE row per (client,item).
--    geom is the include/exclude polygon; district_ids carries the district id(s)
--    for the point-less-candidate fallback. validation_status rolls up the item's
--    element/rule validity (v1 point rules are always 'ok'; an unresolved element
--    or an unsupported rule compiles to 'needs_review' and is skipped in matching).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.client_pref_geometry (
  client_id          uuid NOT NULL,
  item_id            text NOT NULL,
  polarity           text NOT NULL,                     -- 'include' | 'exclude'
  kind               text NOT NULL,                     -- 'district' | 'element_rule'
  geom               geometry(Geometry, 4326),          -- NULL only when needs_review
  district_ids       uuid[] NOT NULL DEFAULT '{}',
  validation_status  text NOT NULL DEFAULT 'ok',
  compiled_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, item_id)
);
CREATE INDEX IF NOT EXISTS client_pref_geometry_geom_gix ON public.client_pref_geometry USING gist (geom);
CREATE INDEX IF NOT EXISTS client_pref_geometry_client_idx ON public.client_pref_geometry (client_id);
ALTER TABLE public.client_pref_geometry ENABLE ROW LEVEL SECURITY;  -- definer-functions only

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Compile: read clients.data.location_items → rebuild this client's compiled
--    geometry. Idempotent (delete + reinsert in one call). Returns a small JSON
--    summary so the caller knows whether ANY usable include exists (→ whether to
--    gate the finder at all). SECURITY DEFINER (reads clients + reference tables,
--    writes client_pref_geometry) with a pinned search_path.
--
--    MUST stay semantically identical to the TS reference in
--    api/_lib/geoMatch.ts (compileItem) — two implementations of one recipe.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_compile_client_geo(p_client_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_items     jsonb;
  v_item      jsonb;
  v_cond      jsonb;
  v_kind      text;
  v_polarity  text;
  v_item_id   text;
  v_district  uuid;
  v_geom      geometry;
  v_buf       geometry;
  v_vstatus   text;
  v_dids      uuid[];
  v_elem_geom geometry;
  v_elem_vst  text;
  v_dist      double precision;
  v_includes  int := 0;
  v_excludes  int := 0;
  v_review    int := 0;
  v_n         int := 0;
BEGIN
  SELECT r.data->'location_items' INTO v_items
  FROM public.records r
  JOIN public.models m ON m.id = r.model_id
  WHERE m.name = 'clients' AND r.id = p_client_id
  LIMIT 1;

  DELETE FROM public.client_pref_geometry WHERE client_id = p_client_id;

  IF v_items IS NULL OR jsonb_typeof(v_items) <> 'array' THEN
    RETURN jsonb_build_object('compiled', 0, 'includes', 0, 'excludes', 0, 'needs_review', 0);
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items)
  LOOP
    v_kind     := coalesce(v_item->>'kind', '');
    v_polarity := lower(coalesce(v_item->>'polarity', 'include'));
    IF v_polarity NOT IN ('include', 'exclude') THEN v_polarity := 'include'; END IF;
    v_item_id  := coalesce(v_item->>'id', 'item_' || v_n::text);
    v_geom     := NULL;
    v_dids     := '{}';
    v_vstatus  := 'ok';

    IF v_kind = 'district' THEN
      v_district := NULL;
      BEGIN
        v_district := (v_item->>'district_id')::uuid;
      EXCEPTION WHEN others THEN
        v_district := NULL;  -- malformed id → unusable item
      END;
      IF v_district IS NULL THEN
        v_vstatus := 'needs_review';
      ELSE
        SELECT ST_Multi(b.geom) INTO v_geom
        FROM public.district_boundaries b
        WHERE b.district_record_id = v_district AND b.is_active
        LIMIT 1;
        v_dids := ARRAY[v_district];
        -- No boundary polygon? still usable for POINT-LESS candidates via district_ids,
        -- so keep it 'ok' (geom may be NULL — match handles district-id membership).
      END IF;

    ELSIF v_kind = 'element_rule' THEN
      -- v1: intersect (AND) the rule's conditions. Only within_radius of a POINT
      -- element is supported; any other rule marks the item needs_review.
      IF jsonb_typeof(v_item->'conditions') = 'array' THEN
        FOR v_cond IN SELECT * FROM jsonb_array_elements(v_item->'conditions')
        LOOP
          IF coalesce(v_cond->>'rule', '') = 'within_radius' THEN
            v_dist := public.try_numeric(v_cond->>'distance_m');
            SELECT e.geom, e.validation_status INTO v_elem_geom, v_elem_vst
            FROM public.geo_elements e
            WHERE e.id = (v_cond->>'element_id')::uuid AND e.is_active
            LIMIT 1;
            IF v_elem_geom IS NULL OR v_dist IS NULL OR v_dist <= 0 THEN
              v_vstatus := 'needs_review';
            ELSE
              IF coalesce(v_elem_vst, 'ok') <> 'ok' THEN v_vstatus := 'needs_review'; END IF;
              -- geography buffer = metre-accurate great-circle disc. quad_segs pinned
              -- for reproducible geometry across runs/servers.
              v_buf := ST_Buffer(v_elem_geom::geography, v_dist, 'quad_segs=16')::geometry;
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
    IF v_vstatus = 'needs_review' THEN
      v_review := v_review + 1;
    ELSIF v_polarity = 'include' THEN
      v_includes := v_includes + 1;
    ELSE
      v_excludes := v_excludes + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'compiled', v_n, 'includes', v_includes, 'excludes', v_excludes, 'needs_review', v_review
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.wassell_compile_client_geo(uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Match: compiled geometry → matched candidate record ids (projects + listings),
--    union of includes minus excludes, with point-less district fallback. Returns
--    matched_item_ids per candidate for explainability. STABLE SECURITY DEFINER.
--
--    MUST stay semantically identical to api/_lib/geoMatch.ts (matchCandidates).
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.wassell_geo_match(p_client_id uuid)
RETURNS TABLE(record_id uuid, matched_item_ids text[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH inc AS (
    SELECT item_id, geom, district_ids
    FROM public.client_pref_geometry
    WHERE client_id = p_client_id AND polarity = 'include' AND validation_status = 'ok'
  ),
  exc AS (
    SELECT geom, district_ids
    FROM public.client_pref_geometry
    WHERE client_id = p_client_id AND polarity = 'exclude' AND validation_status = 'ok'
  ),
  inc_area AS (SELECT ST_Union(geom) AS g FROM inc WHERE geom IS NOT NULL),
  exc_area AS (SELECT ST_Union(geom) AS g FROM exc WHERE geom IS NOT NULL),
  inc_dids AS (SELECT coalesce(array_agg(DISTINCT x), '{}'::uuid[]) AS ids FROM inc, unnest(district_ids) x),
  exc_dids AS (SELECT coalesce(array_agg(DISTINCT x), '{}'::uuid[]) AS ids FROM exc, unnest(district_ids) x),
  cand AS (
    SELECT record_id, geom, district_id FROM public.project_points WHERE is_active
    UNION ALL
    SELECT record_id, geom, district_id FROM public.listing_points WHERE is_active
  )
  SELECT c.record_id,
         (
           SELECT coalesce(array_agg(i.item_id), '{}'::text[])
           FROM inc i
           WHERE (c.geom IS NOT NULL AND i.geom IS NOT NULL AND ST_Contains(i.geom, c.geom))
              OR (c.geom IS NULL AND c.district_id IS NOT NULL AND c.district_id = ANY(i.district_ids))
         ) AS matched_item_ids
  FROM cand c, inc_area ia, exc_area ea, inc_dids idd, exc_dids edd
  WHERE
    -- IN the union of includes (point inside an include area, OR point-less
    -- candidate whose stored district is an include district).
    (
      (c.geom IS NOT NULL AND ia.g IS NOT NULL AND c.geom && ia.g AND ST_Contains(ia.g, c.geom))
      OR (c.geom IS NULL AND c.district_id IS NOT NULL AND c.district_id = ANY(idd.ids))
    )
    -- NOT in any exclude (pin inside an exclude area, OR district in an exclude district).
    AND NOT (
      (c.geom IS NOT NULL AND ea.g IS NOT NULL AND c.geom && ea.g AND ST_Contains(ea.g, c.geom))
      OR (c.district_id IS NOT NULL AND c.district_id = ANY(edd.ids))
    )
$$;

GRANT EXECUTE ON FUNCTION public.wassell_geo_match(uuid) TO authenticated, service_role;

COMMIT;
