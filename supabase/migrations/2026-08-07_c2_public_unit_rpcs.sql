-- ============================================================================
-- Public project pages redesign — W1 (units): scalable public unit RPCs.
--
--   • get_public_project_unit_summary(p_project) — TRUE totals over ALL units
--     (per-status, grouped by type + bedrooms with available-only ranges).
--   • get_public_project_units(p_project, limit, offset, group, filters) —
--     server-side paginated + filtered allowlisted unit DTOs.
--
-- Explicit allowlist (only these keys are emitted). Excluded: every source_*
-- (except source_price/source_currency surfaced AS the native price — never
-- source_fx_rate/source_file/source_*_area), developer_id, developer_unit_code,
-- unit_number, notes, mirrors. Plan image returned as a file-id ref (the website
-- signs it). SECURITY DEFINER so counts cover ALL units regardless of caller RLS.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_public_project_unit_summary(p_project uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_units uuid := public._pub_model_id('units');
  v_ap    uuid := public._pub_model_id('all_projects');
  v_pid   text := p_project::text;
  a record;
  v_by_type jsonb;
  v_by_bed  jsonb;
BEGIN
  -- gate: project must be public
  IF NOT EXISTS (SELECT 1 FROM public.records WHERE id=p_project AND model_id=v_ap
                 AND COALESCE((data->>'is_public')::boolean,false)=true) THEN
    RETURN NULL;
  END IF;

  SELECT
    count(*) AS total,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available')) AS available,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','sold'))       AS sold,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','reserved'))   AS reserved
  INTO a
  FROM public.records u
  WHERE u.model_id=v_units
    AND (u.data->>'project_id'=v_pid OR (jsonb_typeof(u.data->'project_id')='array' AND u.data->'project_id' ? v_pid));

  -- group by unit_type
  SELECT COALESCE(jsonb_agg(g ORDER BY (g->>'count')::int DESC), '[]'::jsonb) INTO v_by_type FROM (
    SELECT jsonb_build_object(
      'type', public._pub_opt('units','unit_type', ut, 'ar'),
      'type_en', (public._pub_opt('units','unit_type', ut, 'en'))->>'label',
      'count', cnt,
      'available', avail,
      'price_range', public._rollup_range(pmin, pmax),
      'area_range', public._rollup_range(amin, amax)
    ) AS g
    FROM (
      SELECT NULLIF(btrim(u.data->>'unit_type'),'') AS ut,
             count(*) AS cnt,
             count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available')) AS avail,
             min(public.try_numeric(u.data->>'total_price')) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available')) AS pmin,
             max(public.try_numeric(u.data->>'total_price')) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available')) AS pmax,
             min(public.try_numeric(u.data->>'unit_area')) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available')) AS amin,
             max(public.try_numeric(u.data->>'unit_area')) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available')) AS amax
      FROM public.records u
      WHERE u.model_id=v_units
        AND (u.data->>'project_id'=v_pid OR (jsonb_typeof(u.data->'project_id')='array' AND u.data->'project_id' ? v_pid))
        AND NULLIF(btrim(u.data->>'unit_type'),'') IS NOT NULL
      GROUP BY 1
    ) t
  ) q;

  -- group by bedrooms
  SELECT COALESCE(jsonb_agg(g ORDER BY (g->>'bedrooms')::numeric NULLS LAST), '[]'::jsonb) INTO v_by_bed FROM (
    SELECT jsonb_build_object(
      'bedrooms', bed,
      'count', cnt,
      'available', avail,
      'price_range', public._rollup_range(pmin, pmax),
      'area_range', public._rollup_range(amin, amax)
    ) AS g
    FROM (
      SELECT public.try_numeric(u.data->>'bedrooms') AS bed,
             count(*) AS cnt,
             count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available')) AS avail,
             min(public.try_numeric(u.data->>'total_price')) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available')) AS pmin,
             max(public.try_numeric(u.data->>'total_price')) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available')) AS pmax,
             min(public.try_numeric(u.data->>'unit_area')) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available')) AS amin,
             max(public.try_numeric(u.data->>'unit_area')) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available')) AS amax
      FROM public.records u
      WHERE u.model_id=v_units
        AND (u.data->>'project_id'=v_pid OR (jsonb_typeof(u.data->'project_id')='array' AND u.data->'project_id' ? v_pid))
        AND public.try_numeric(u.data->>'bedrooms') IS NOT NULL
      GROUP BY 1
    ) t
  ) q;

  RETURN jsonb_build_object(
    'total', COALESCE(a.total,0),
    'available', COALESCE(a.available,0),
    'sold', COALESCE(a.sold,0),
    'reserved', COALESCE(a.reserved,0),
    'by_type', v_by_type,
    'by_bedrooms', v_by_bed
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.get_public_project_units(
  p_project uuid,
  p_limit int DEFAULT 24,
  p_offset int DEFAULT 0,
  p_lang text DEFAULT 'ar',
  p_filters jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_units uuid := public._pub_model_id('units');
  v_ap    uuid := public._pub_model_id('all_projects');
  v_pid   text := p_project::text;
  v_lang  text := CASE WHEN lower(coalesce(p_lang,'ar'))='en' THEN 'en' ELSE 'ar' END;
  v_lim   int  := LEAST(GREATEST(COALESCE(p_limit,24),1), 60);   -- hard ceiling 60/page
  v_off   int  := GREATEST(COALESCE(p_offset,0),0);
  v_ftype text := NULLIF(btrim(p_filters->>'unit_type'),'');
  v_fstatus text := NULLIF(btrim(p_filters->>'status'),'');
  v_fbed  numeric := public.try_numeric(p_filters->>'bedrooms');
  v_fmin  numeric := public.try_numeric(p_filters->>'min_price');
  v_fmax  numeric := public.try_numeric(p_filters->>'max_price');
  v_total int;
  v_rows jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.records WHERE id=p_project AND model_id=v_ap
                 AND COALESCE((data->>'is_public')::boolean,false)=true) THEN
    RETURN NULL;
  END IF;

  WITH filtered AS (
    SELECT u.id, u.data
    FROM public.records u
    WHERE u.model_id=v_units
      AND (u.data->>'project_id'=v_pid OR (jsonb_typeof(u.data->'project_id')='array' AND u.data->'project_id' ? v_pid))
      AND (v_ftype   IS NULL OR btrim(u.data->>'unit_type') = v_ftype)
      AND (v_fbed    IS NULL OR public.try_numeric(u.data->>'bedrooms') = v_fbed)
      AND (v_fstatus IS NULL OR public._rollup_status_is(u.data->>'unit_status', v_fstatus))
      AND (v_fmin    IS NULL OR public.try_numeric(u.data->>'total_price') >= v_fmin)
      AND (v_fmax    IS NULL OR public.try_numeric(u.data->>'total_price') <= v_fmax)
  )
  SELECT count(*)::int INTO v_total FROM filtered;

  WITH filtered AS (
    SELECT u.id, u.data
    FROM public.records u
    WHERE u.model_id=v_units
      AND (u.data->>'project_id'=v_pid OR (jsonb_typeof(u.data->'project_id')='array' AND u.data->'project_id' ? v_pid))
      AND (v_ftype   IS NULL OR btrim(u.data->>'unit_type') = v_ftype)
      AND (v_fbed    IS NULL OR public.try_numeric(u.data->>'bedrooms') = v_fbed)
      AND (v_fstatus IS NULL OR public._rollup_status_is(u.data->>'unit_status', v_fstatus))
      AND (v_fmin    IS NULL OR public.try_numeric(u.data->>'total_price') >= v_fmin)
      AND (v_fmax    IS NULL OR public.try_numeric(u.data->>'total_price') <= v_fmax)
    ORDER BY public.try_numeric(u.data->>'total_price') NULLS LAST, u.id
    LIMIT v_lim OFFSET v_off
  )
  SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id', f.id,
    'unit_code', NULLIF(btrim(f.data->>'unit_code'),''),
    'unit_type', public._pub_opt('units','unit_type', f.data->>'unit_type', v_lang),
    'unit_status', public._pub_opt('units','unit_status', f.data->>'unit_status', v_lang),
    'floor', (public._pub_opt('units','floor', f.data->>'floor', v_lang))->>'label',
    'bedrooms', public.try_numeric(f.data->>'bedrooms'),
    'bathrooms', public.try_numeric(f.data->>'bathrooms'),
    'unit_area', public.try_numeric(f.data->>'unit_area'),
    'total_area', public.try_numeric(f.data->>'total_area'),
    'balcony_area', public.try_numeric(f.data->>'balcony_area'),
    'terrace_area', public.try_numeric(f.data->>'terrace_area'),
    'view', NULLIF(btrim(f.data->>'view'),''),
    'components', public._pub_opt_labels('units','unit_components', f.data->'unit_components', v_lang),
    'price', public.try_numeric(f.data->>'total_price'),
    'native_price', public.try_numeric(f.data->>'source_price'),
    'native_currency', CASE WHEN public.try_numeric(f.data->>'source_price') IS NOT NULL THEN NULLIF(f.data->>'source_currency','') END,
    'plan_file', NULLIF(btrim(f.data->>'unit_plan'),'')
  )) ORDER BY public.try_numeric(f.data->>'total_price') NULLS LAST, f.id), '[]'::jsonb) INTO v_rows
  FROM filtered f;

  RETURN jsonb_build_object(
    'total_filtered', v_total,
    'limit', v_lim,
    'offset', v_off,
    'units', v_rows
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_public_project_unit_summary(uuid)                 TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_project_units(uuid, int, int, text, jsonb) TO anon, authenticated;
