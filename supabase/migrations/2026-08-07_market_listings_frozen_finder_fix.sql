-- Restore the Project Finder's market_listings source after the model was FROZEN.
--
-- Freezing market_listings moved all 314k rows from public.records into the
-- dedicated public.market_listings table. Two things silently broke:
--   1. public.listing_points (the indexed geo/typed-filter table the finder and
--      wassell_geo_match read) was maintained by a trigger on public.records
--      (_sync_geo_point). When the freeze deleted the market rows from records,
--      that trigger emptied listing_points AND stopped maintaining it. Result: 0
--      rows -> every finder market search + every drawn-area geo match returns
--      nothing.
--   2. wassell_market_candidates_json / wassell_market_candidates still read
--      listing DATA `FROM public.records` (now empty for this model), so even the
--      district path returned an empty set with status 'ok' (no warning banner) —
--      market listings just silently vanished from the finder.
-- A third latent defect: the freeze stored the `location` field as TEXT holding a
-- JSON string, so market_listings_v.data->'location' is a string, not an object.
-- The finder JS (recordLocationIds / scoring) needs it as an object, so the RPCs
-- normalize it back on output.
--
-- Fix: repopulate + maintain listing_points from the FROZEN table, and point the
-- two market-candidate RPCs at listing_points (filter) + market_listings_v (data,
-- with location normalized). No frozen-table DDL, no view-chain unwind.

BEGIN;

-- ── 1. Safe JSON parse helper (returns NULL instead of erroring on bad text) ──
CREATE OR REPLACE FUNCTION public.try_jsonb(p text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN NULL; END IF;
  RETURN p::jsonb;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- Normalize a listing's `data.location` from a JSON *string* (how the freeze
-- stored it) back to a JSON object, so recordLocationIds() and the scorer read
-- district/city correctly. No-op when it's already an object or absent.
CREATE OR REPLACE FUNCTION public._market_normalize_location(d jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN d ? 'location' AND jsonb_typeof(d->'location') = 'string'
      THEN jsonb_set(d, '{location}', coalesce(public.try_jsonb(d->>'location'), 'null'::jsonb))
    ELSE d
  END
$$;

-- ── 2. Maintain listing_points from the FROZEN market_listings table ─────────
-- Mirrors the market branch of _sync_geo_point, but reads the frozen table's
-- typed columns (price/bedrooms/area numeric; age text; location text-JSON).
CREATE OR REPLACE FUNCTION public._sync_listing_point_frozen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_loc      jsonb;
  v_district uuid;
  v_geom     geometry;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.listing_points WHERE record_id = OLD.id;
    RETURN OLD;
  END IF;

  v_loc := public.try_jsonb(NEW.location);
  v_district := CASE
    WHEN (v_loc->>'district') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (v_loc->>'district')::uuid
  END;
  v_geom := CASE
    WHEN NEW.latitude IS NOT NULL AND NEW.longitude IS NOT NULL
         AND NEW.latitude BETWEEN -90 AND 90 AND NEW.longitude BETWEEN -180 AND 180
      THEN ST_SetSRID(ST_MakePoint(NEW.longitude::double precision, NEW.latitude::double precision), 4326)
  END;

  INSERT INTO public.listing_points (record_id, geom, district_id, is_active, updated_at,
                                     price, bedrooms, type_text, unit_age, area)
  VALUES (NEW.id, v_geom, v_district, coalesce(NEW.is_active, true), now(),
          NEW.price, NEW.bedrooms,
          trim(concat_ws(' ', NEW.property_type, NEW.listing_type, NEW.category)),
          public.wassell_parse_unit_age(NEW.age), NEW.area)
  ON CONFLICT (record_id) DO UPDATE
    SET geom = EXCLUDED.geom, district_id = EXCLUDED.district_id,
        is_active = EXCLUDED.is_active, updated_at = now(),
        price = EXCLUDED.price, bedrooms = EXCLUDED.bedrooms,
        type_text = EXCLUDED.type_text, unit_age = EXCLUDED.unit_age,
        area = EXCLUDED.area;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS market_listings_sync_listing_point ON public.market_listings;
CREATE TRIGGER market_listings_sync_listing_point
  AFTER INSERT OR UPDATE OR DELETE ON public.market_listings
  FOR EACH ROW EXECUTE FUNCTION public._sync_listing_point_frozen();

-- ── 3. Backfill listing_points from the 314k frozen rows ─────────────────────
INSERT INTO public.listing_points (record_id, geom, district_id, is_active, updated_at,
                                   price, bedrooms, type_text, unit_age, area)
SELECT t.id,
       CASE
         WHEN t.latitude IS NOT NULL AND t.longitude IS NOT NULL
              AND t.latitude BETWEEN -90 AND 90 AND t.longitude BETWEEN -180 AND 180
           THEN ST_SetSRID(ST_MakePoint(t.longitude::double precision, t.latitude::double precision), 4326)
       END,
       CASE
         WHEN (public.try_jsonb(t.location)->>'district') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           THEN (public.try_jsonb(t.location)->>'district')::uuid
       END,
       coalesce(t.is_active, true), now(),
       t.price, t.bedrooms,
       trim(concat_ws(' ', t.property_type, t.listing_type, t.category)),
       public.wassell_parse_unit_age(t.age), t.area
FROM public.market_listings t
ON CONFLICT (record_id) DO UPDATE
  SET geom = EXCLUDED.geom, district_id = EXCLUDED.district_id,
      is_active = EXCLUDED.is_active, updated_at = now(),
      price = EXCLUDED.price, bedrooms = EXCLUDED.bedrooms,
      type_text = EXCLUDED.type_text, unit_age = EXCLUDED.unit_age,
      area = EXCLUDED.area;

-- ── 4. Rewrite the JSON candidate RPC (finder) to read the frozen source ─────
-- Both scopes (requested district_ids OR a compiled geo record_id set) now filter
-- on the indexed listing_points, and DATA comes from market_listings_v with
-- location normalized. All market_listings viewers resolve to scope class 'all'
-- (no per-profile view_scope filter exists), so the dead per-row visibility check
-- is dropped; the v_klass='none' guard still denies users without view access.
CREATE OR REPLACE FUNCTION public.wassell_market_candidates_json(
  p_model_id uuid, p_district_ids text[],
  p_budget_min numeric DEFAULT NULL, p_budget_max numeric DEFAULT NULL,
  p_bedrooms numeric DEFAULT NULL, p_type_terms text[] DEFAULT NULL,
  p_limit integer DEFAULT 4000, p_record_ids uuid[] DEFAULT NULL,
  p_fields text[] DEFAULT NULL, p_max_age numeric DEFAULT NULL,
  p_area_min numeric DEFAULT NULL, p_area_max numeric DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '25s'
AS $function$
DECLARE
  v_klass text := public.wassell_view_scope_class(auth.uid(), p_model_id);
  v_out jsonb;
BEGIN
  IF v_klass = 'none' THEN
    RETURN jsonb_build_object('total', 0, 'rows', '[]'::jsonb);
  END IF;
  IF p_record_ids IS NULL AND p_district_ids IS NULL THEN
    RETURN jsonb_build_object('total', 0, 'rows', '[]'::jsonb);
  END IF;

  WITH filtered AS MATERIALIZED (
    SELECT lp.record_id AS id
    FROM public.listing_points lp
    WHERE (
        (p_record_ids IS NOT NULL AND lp.record_id = ANY(p_record_ids))
        OR (p_record_ids IS NULL AND p_district_ids IS NOT NULL
            AND lp.district_id = ANY(p_district_ids::uuid[]))
      )
      AND (
        p_budget_max IS NULL OR lp.price IS NULL
        OR (lp.price <= p_budget_max AND (p_budget_min IS NULL OR lp.price >= p_budget_min))
      )
      AND (p_bedrooms IS NULL OR lp.bedrooms IS NULL OR lp.bedrooms >= p_bedrooms)
      AND (
        lp.area IS NULL
        OR ((p_area_min IS NULL OR lp.area >= p_area_min)
            AND (p_area_max IS NULL OR lp.area <= p_area_max))
      )
      AND (
        p_type_terms IS NULL OR coalesce(lp.type_text, '') = ''
        OR EXISTS (SELECT 1 FROM unnest(p_type_terms) t WHERE lp.type_text ILIKE '%' || t || '%')
      )
      AND (p_max_age IS NULL OR lp.unit_age IS NULL OR lp.unit_age <= p_max_age)
  ),
  tot AS (SELECT count(*) AS n FROM filtered),
  sel AS (SELECT id FROM filtered ORDER BY id LIMIT p_limit)
  SELECT jsonb_build_object(
    'total', (SELECT n FROM tot),
    'rows', CASE
      WHEN (SELECT n FROM tot) > p_limit THEN '[]'::jsonb
      ELSE coalesce(
        (SELECT jsonb_agg(jsonb_build_object(
                  'id', r.id,
                  'data', public._market_normalize_location(
                    CASE
                      WHEN p_fields IS NULL THEN r.data
                      ELSE coalesce(
                        (SELECT jsonb_object_agg(key, value)
                           FROM jsonb_each(r.data) WHERE key = ANY(p_fields)),
                        '{}'::jsonb)
                    END)
                ) ORDER BY r.id)
           FROM public.market_listings_v r
           JOIN sel s ON s.id = r.id),
        '[]'::jsonb)
    END)
  INTO v_out;
  RETURN v_out;
END;
$function$;

-- ── 5. Rewrite the TABLE-returning sibling (Market Intelligence) the same way ─
-- Preserves its original filter semantics (bedrooms EQUALITY; no area/age params)
-- but sources rows from listing_points + market_listings_v instead of records.
CREATE OR REPLACE FUNCTION public.wassell_market_candidates(
  p_model_id uuid, p_district_ids text[],
  p_budget_min numeric DEFAULT NULL, p_budget_max numeric DEFAULT NULL,
  p_bedrooms numeric DEFAULT NULL, p_type_terms text[] DEFAULT NULL,
  p_limit integer DEFAULT 4001, p_record_ids uuid[] DEFAULT NULL)
RETURNS TABLE(id uuid, data jsonb)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF public.wassell_view_scope_class(auth.uid(), p_model_id) = 'none' THEN
    RETURN;
  END IF;
  IF p_record_ids IS NULL AND p_district_ids IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    WITH filtered AS (
      SELECT lp.record_id AS rid
      FROM public.listing_points lp
      WHERE (
          (p_record_ids IS NOT NULL AND lp.record_id = ANY(p_record_ids))
          OR (p_record_ids IS NULL AND p_district_ids IS NOT NULL
              AND lp.district_id = ANY(p_district_ids::uuid[]))
        )
        AND (
          p_budget_max IS NULL OR lp.price IS NULL
          OR (lp.price <= p_budget_max AND (p_budget_min IS NULL OR lp.price >= p_budget_min))
        )
        AND (p_bedrooms IS NULL OR lp.bedrooms IS NULL OR lp.bedrooms = p_bedrooms)
        AND (
          p_type_terms IS NULL OR coalesce(lp.type_text, '') = ''
          OR EXISTS (SELECT 1 FROM unnest(p_type_terms) t WHERE lp.type_text ILIKE '%' || t || '%')
        )
      ORDER BY lp.record_id
      LIMIT p_limit
    )
    SELECT r.id, public._market_normalize_location(r.data)
    FROM public.market_listings_v r
    JOIN filtered f ON f.rid = r.id
    ORDER BY r.id;
END;
$function$;

COMMIT;
