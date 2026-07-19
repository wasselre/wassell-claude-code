-- Finder bedrooms filter: exact-equality → AT-LEAST (2026-07-19).
--
-- The market pre-filter dropped any listing whose bedroom count differed from
-- the request (`lp.bedrooms = p_bedrooms`), so a 7-bedroom villa never surfaced
-- for a 6-bedroom client — even though more bedrooms than requested is
-- acceptable (fewer is the real miss). Live example (2026-07-19): a 1.9M/300m²
-- 7BR villa in ظهرة لبن with غرفة سائق + ملحق was invisible to a 6BR request.
--
-- Change: `= p_bedrooms` → `>= p_bedrooms` in BOTH paths (typed fast path over
-- listing_points, legacy records-scan path). Matches the scorer's new at-least
-- semantics (matchAgent.ts bedrooms subscore) and the SPA's client-side
-- `bedroomsMin` refine, which already treated the number as a minimum.
-- NULL/unparsable bedroom data still passes (missing-tolerant, unchanged).
--
-- Everything else in the function body is IDENTICAL to
-- 2026-07-18_listing_points_typed_filters.sql.

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
        AND (p_bedrooms IS NULL OR lp.bedrooms IS NULL OR lp.bedrooms >= p_bedrooms)
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
        OR (r.data ->> 'bedrooms')::numeric >= p_bedrooms
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
