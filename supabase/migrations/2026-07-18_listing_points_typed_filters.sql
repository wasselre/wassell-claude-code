-- Part 2 of the direction-rule finder timeout fix (2026-07-18).
--
-- EXPLAIN showed the remaining ~19-25s: the market scan probed `records` once
-- per gate id (34k index probes) and DETOASTED each fat listing jsonb just to
-- evaluate price/bedrooms/type filters — 0.54ms x 34k. The filterable fields
-- now live as TYPED columns on `listing_points` (the trigger-maintained
-- geo side table), so the count phase never touches `records`; the fat jsonb
-- is fetched only for the <= p_limit rows actually returned.
--
-- Semantics preserved exactly:
--  * price/bedrooms: try_numeric(NULL on unparsable) == the old "non-numeric
--    string passes the filter" regex rule.
--  * type: type_text = trim(concat_ws(' ', property_type, listing_type,
--    category)); '' == "no type data → passes"; a term ILIKE-matching the
--    concatenated haystack == matching any of the three fields.
--  * age: wassell_parse_unit_age, NULL passes.
--  * Scope: klass 'all' takes the typed fast path (no per-row access check —
--    same short-circuit as before); klass 'filtered' keeps the legacy
--    records-scan path with per-row wassell_can_view_record; 'none' → empty.
--
-- The typed fast path applies to the p_record_ids (geo gate) branch. The
-- district branch keeps the legacy scan (already ~2-3s for dense districts and
-- it reads the jsonb location key directly — no behavior risk taken there).

-- ── 1. Typed filter columns on listing_points ───────────────────────────────
ALTER TABLE public.listing_points
  ADD COLUMN IF NOT EXISTS price numeric,
  ADD COLUMN IF NOT EXISTS bedrooms numeric,
  ADD COLUMN IF NOT EXISTS type_text text,
  ADD COLUMN IF NOT EXISTS unit_age numeric;

-- ── 2. Trigger keeps them in sync (listings branch only) ────────────────────
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
                                       price, bedrooms, type_text, unit_age)
    VALUES (NEW.id, public._geo_point_from_data(NEW.data), public._geo_district_from_data(NEW.data),
            coalesce((NEW.data->>'is_active')::boolean, true), now(),
            public.try_numeric(NEW.data->>'price'),
            public.try_numeric(NEW.data->>'bedrooms'),
            trim(concat_ws(' ', NEW.data->>'property_type', NEW.data->>'listing_type', NEW.data->>'category')),
            public.wassell_parse_unit_age(NEW.data->>'age'))
    ON CONFLICT (record_id) DO UPDATE
      SET geom = EXCLUDED.geom, district_id = EXCLUDED.district_id,
          is_active = EXCLUDED.is_active, updated_at = now(),
          price = EXCLUDED.price, bedrooms = EXCLUDED.bedrooms,
          type_text = EXCLUDED.type_text, unit_age = EXCLUDED.unit_age;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 3. One-time backfill ────────────────────────────────────────────────────
UPDATE public.listing_points lp
SET price = public.try_numeric(r.data->>'price'),
    bedrooms = public.try_numeric(r.data->>'bedrooms'),
    type_text = trim(concat_ws(' ', r.data->>'property_type', r.data->>'listing_type', r.data->>'category')),
    unit_age = public.wassell_parse_unit_age(r.data->>'age')
FROM public.records r
WHERE r.id = lp.record_id;

-- ── 4. Market RPC: typed fast path for the geo-gate branch ──────────────────
CREATE OR REPLACE FUNCTION public.wassell_market_candidates_json(
  p_model_id uuid, p_district_ids text[],
  p_budget_min numeric DEFAULT NULL, p_budget_max numeric DEFAULT NULL,
  p_bedrooms numeric DEFAULT NULL, p_type_terms text[] DEFAULT NULL,
  p_limit integer DEFAULT 4000, p_record_ids uuid[] DEFAULT NULL,
  p_fields text[] DEFAULT NULL, p_max_age numeric DEFAULT NULL)
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
    -- TYPED FAST PATH: count over listing_points columns only (no records
    -- probe, no jsonb detoast); fetch the fat rows for <= p_limit ids.
    WITH filtered AS MATERIALIZED (
      SELECT lp.record_id AS id
      FROM public.listing_points lp
      JOIN (SELECT unnest(p_record_ids) AS id) ids ON ids.id = lp.record_id
      WHERE (
          p_budget_max IS NULL OR lp.price IS NULL
          OR (lp.price <= p_budget_max AND (p_budget_min IS NULL OR lp.price >= p_budget_min))
        )
        AND (p_bedrooms IS NULL OR lp.bedrooms IS NULL OR lp.bedrooms = p_bedrooms)
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

  -- LEGACY PATH (district scope, or filtered-scope users needing the per-row
  -- access check): records scan with hashed id membership + ids-only count.
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
        OR (r.data ->> 'bedrooms')::numeric = p_bedrooms
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
