-- Market pre-filter gains an AREA band (2026-07-19).
--
-- Area was the ONLY stated requirement with no pre-filter at all: every listing
-- in the district arrived and merely lost the 10-of-90 area weight, so a 125 m²
-- villa still scored 89% against a 500–750 m² request and ranked above real
-- matches. With per-field constraints (api/_lib/constraints.ts) area defaults to
-- HARD ±15%, so the band belongs in SQL too — both to enforce it cheaply and to
-- shrink the scanned set (which is what the 4,000-row too_many cap keys off).
--
-- Adds listing_points.area (typed side-table column, same pattern as price /
-- bedrooms / type_text / unit_age from 2026-07-18_listing_points_typed_filters)
-- plus p_area_min / p_area_max on the RPC, applied in BOTH paths.
--
-- MISSING-TOLERANT, deliberately: a listing whose area is NULL or unparsable
-- PASSES the SQL filter and is rejected (or not) by the JS gate
-- `firstFailedHardConstraint`. One missing-data policy, in one place — the SQL
-- never silently applies a different rule than the engine.
--
-- New params are appended with defaults, so existing callers are unaffected.

-- ── 1. Typed area column on listing_points ──────────────────────────────────
ALTER TABLE public.listing_points ADD COLUMN IF NOT EXISTS area numeric;

-- ── 2. Trigger keeps it in sync (listings branch) ───────────────────────────
CREATE OR REPLACE FUNCTION public._sync_geo_point()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    INSERT INTO public.listing_points (record_id, geom, district_id, is_active, updated_at,
                                       price, bedrooms, type_text, unit_age, area)
    VALUES (NEW.id, public._geo_point_from_data(NEW.data), public._geo_district_from_data(NEW.data),
            coalesce((NEW.data->>'is_active')::boolean, true), now(),
            public.try_numeric(NEW.data->>'price'),
            public.try_numeric(NEW.data->>'bedrooms'),
            trim(concat_ws(' ', NEW.data->>'property_type', NEW.data->>'listing_type', NEW.data->>'category')),
            public.wassell_parse_unit_age(NEW.data->>'age'),
            public.try_numeric(NEW.data->>'area'))
    ON CONFLICT (record_id) DO UPDATE
      SET geom = EXCLUDED.geom, district_id = EXCLUDED.district_id,
          is_active = EXCLUDED.is_active, updated_at = now(),
          price = EXCLUDED.price, bedrooms = EXCLUDED.bedrooms,
          type_text = EXCLUDED.type_text, unit_age = EXCLUDED.unit_age,
          area = EXCLUDED.area;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 3. One-time backfill ────────────────────────────────────────────────────
UPDATE public.listing_points lp
SET area = public.try_numeric(r.data->>'area')
FROM public.records r
WHERE r.id = lp.record_id AND lp.area IS DISTINCT FROM public.try_numeric(r.data->>'area');

-- ── 4. RPC: area band in both paths ─────────────────────────────────────────
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

  IF p_record_ids IS NOT NULL AND v_klass = 'all' THEN
    WITH filtered AS MATERIALIZED (
      SELECT lp.record_id AS id
      FROM public.listing_points lp
      JOIN (SELECT unnest(p_record_ids) AS id) ids ON ids.id = lp.record_id
      WHERE (
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
          p_type_terms IS NULL
          OR coalesce(lp.type_text, '') = ''
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
                    'data', CASE
                      WHEN p_fields IS NULL THEN r.data
                      ELSE coalesce(
                        (SELECT jsonb_object_agg(key, value)
                           FROM jsonb_each(r.data) WHERE key = ANY(p_fields)),
                        '{}'::jsonb)
                    END
                  ) ORDER BY r.id)
             FROM public.records r
             JOIN sel s ON s.id = r.id),
          '[]'::jsonb)
      END)
    INTO v_out;
    RETURN v_out;
  END IF;

  WITH filtered AS MATERIALIZED (
    SELECT r.id
    FROM public.records r
    WHERE r.model_id = p_model_id
      AND (
        (p_record_ids IS NOT NULL AND r.id IN (SELECT unnest(p_record_ids)))
        OR (p_record_ids IS NULL AND p_district_ids IS NOT NULL
            AND (r.data -> 'location' ->> 'district') = ANY(p_district_ids))
      )
      AND (
        p_budget_max IS NULL
        OR (r.data ->> 'price') IS NULL
        OR (r.data ->> 'price') !~ '^[0-9]+(\.[0-9]+)?$'
        OR (
          (r.data ->> 'price')::numeric <= p_budget_max
          AND (p_budget_min IS NULL OR (r.data ->> 'price')::numeric >= p_budget_min)
        )
      )
      AND (
        p_bedrooms IS NULL
        OR (r.data ->> 'bedrooms') IS NULL
        OR (r.data ->> 'bedrooms') !~ '^[0-9]+(\.[0-9]+)?$'
        OR (r.data ->> 'bedrooms')::numeric >= p_bedrooms
      )
      AND (
        (p_area_min IS NULL AND p_area_max IS NULL)
        OR public.try_numeric(r.data ->> 'area') IS NULL
        OR (
          (p_area_min IS NULL OR public.try_numeric(r.data ->> 'area') >= p_area_min)
          AND (p_area_max IS NULL OR public.try_numeric(r.data ->> 'area') <= p_area_max)
        )
      )
      AND (
        p_type_terms IS NULL
        OR (
          coalesce(r.data ->> 'property_type', '') = ''
          AND coalesce(r.data ->> 'listing_type', '') = ''
          AND coalesce(r.data ->> 'category', '') = ''
        )
        OR EXISTS (
          SELECT 1 FROM unnest(p_type_terms) t
          WHERE (r.data ->> 'property_type') ILIKE '%' || t || '%'
             OR (r.data ->> 'listing_type') ILIKE '%' || t || '%'
             OR (r.data ->> 'category') ILIKE '%' || t || '%'
        )
      )
      AND (
        p_max_age IS NULL
        OR public.wassell_parse_unit_age(r.data ->> 'age') IS NULL
        OR public.wassell_parse_unit_age(r.data ->> 'age') <= p_max_age
      )
      AND (CASE WHEN v_klass = 'all' THEN true
                ELSE public.wassell_can_view_record(auth.uid(), r.*) END)
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
                  'data', CASE
                    WHEN p_fields IS NULL THEN r.data
                    ELSE coalesce(
                      (SELECT jsonb_object_agg(key, value)
                         FROM jsonb_each(r.data) WHERE key = ANY(p_fields)),
                      '{}'::jsonb)
                  END
                ) ORDER BY r.id)
           FROM public.records r
           JOIN sel s ON s.id = r.id),
        '[]'::jsonb)
    END)
  INTO v_out;
  RETURN v_out;
END;
$function$;
