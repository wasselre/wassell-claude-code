-- ============================================================================
-- Public project pages redesign — W2: native available-currency price rollup.
--
-- Dual-currency display for foreign projects (e.g. AED). Adds ONE new stored
-- rollup on all_projects:
--   • available_native_price_range  {min,max}  — rollup_kind
--     'available_native_price_range' — min/max of each AVAILABLE unit's
--     developer-quoted native price (units.source_price), NOT the SAR-converted
--     total_price. Available-only (same matcher as available_price_range).
--
-- The native currency LABEL is NOT stored here — the public read layer reads it
-- from all_projects.developer_currency (already a field). source_fx_rate /
-- source_file etc. stay internal; only the min/max of the native price is
-- surfaced (as an approved aggregate, same posture as available_price_range).
--
-- A project with no available units, or no populated source_price (most SA
-- projects entered SAR directly), yields JSON null → the read layer falls back
-- to SAR-with-label. Never mixes currencies: all units of a project share one
-- source_currency from a single developer import.
--
-- Same architecture as 2026-07-04_available_unit_rollups.sql. The function
-- below REPLACES the LIVE recalc_project_rollups_data verbatim, adding ONLY the
-- two native aggregates and one CASE branch. Idempotent. Safe to re-run.
-- ============================================================================

-- 0. Backup the all_projects model row before mutating its schema JSONB.
CREATE TABLE IF NOT EXISTS public._backup_models_all_projects_20260807 AS
  SELECT * FROM public.models WHERE name = 'all_projects';

-- ────────────────────────────────────────────────────────────────────────
-- 1. Extend the rollup recompute with the native available-price aggregate.
--    Verbatim copy of the LIVE definition + the two avail_native_* aggregates
--    and the one new CASE branch (marked NEW).
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recalc_project_rollups_data(p_project_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_units uuid := public._rollups_units_model_id();
  v_proj  uuid := public._rollups_all_projects_model_id();
  v_pid   text := p_project_id::text;
  a       record;
  v_schema jsonb;
  f       jsonb;
  v_patch jsonb := '{}'::jsonb;
  v_ut_field jsonb;
  v_ut_slug  text;
  v_ut_opts  jsonb;
  v_ut_types jsonb;
BEGIN
  IF v_units IS NULL OR v_proj IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  SELECT
    count(*)                                                                              AS n,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))  AS n_avail,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','sold'))        AS n_sold,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','reserved'))    AS n_res,
    min(public.try_numeric(u.data->>'total_price'))                                        AS price_min,
    max(public.try_numeric(u.data->>'total_price'))                                        AS price_max,
    min(public.try_numeric(u.data->>'unit_area'))                                          AS area_min,
    max(public.try_numeric(u.data->>'unit_area'))                                          AS area_max,
    min(public.try_numeric(u.data->>'total_price'))
      FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))          AS avail_price_min,
    max(public.try_numeric(u.data->>'total_price'))
      FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))          AS avail_price_max,
    min(public.try_numeric(u.data->>'unit_area'))
      FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))          AS avail_area_min,
    max(public.try_numeric(u.data->>'unit_area'))
      FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))          AS avail_area_max,
    -- NEW (W2): native developer-quoted price bounds among AVAILABLE units.
    min(public.try_numeric(u.data->>'source_price'))
      FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))          AS avail_native_price_min,
    max(public.try_numeric(u.data->>'source_price'))
      FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))          AS avail_native_price_max,
    min(public.try_numeric(u.data->>'bedrooms'))                                           AS bed_min,
    max(public.try_numeric(u.data->>'bedrooms'))                                           AS bed_max,
    min(public.try_numeric(u.data->>'bathrooms'))                                          AS bath_min,
    max(public.try_numeric(u.data->>'bathrooms'))                                          AS bath_max,
    min(public.try_numeric(u.data->>'total_price') / nullif(public.try_numeric(u.data->>'unit_area'), 0))
      FILTER (WHERE public.try_numeric(u.data->>'unit_area') > 0
                AND public.try_numeric(u.data->>'total_price') IS NOT NULL)                AS ppm_min,
    max(public.try_numeric(u.data->>'total_price') / nullif(public.try_numeric(u.data->>'unit_area'), 0))
      FILTER (WHERE public.try_numeric(u.data->>'unit_area') > 0
                AND public.try_numeric(u.data->>'total_price') IS NOT NULL)                AS ppm_max,
    avg(public.try_numeric(u.data->>'total_price') / nullif(public.try_numeric(u.data->>'unit_area'), 0))
      FILTER (WHERE public.try_numeric(u.data->>'unit_area') > 0
                AND public.try_numeric(u.data->>'total_price') IS NOT NULL)                AS ppm_avg
  INTO a
  FROM public.records u
  WHERE u.model_id = v_units
    AND (
      u.data->>'project_id' = v_pid
      OR (jsonb_typeof(u.data->'project_id') = 'array' AND u.data->'project_id' ? v_pid)
    );

  SELECT schema INTO v_schema FROM public.models WHERE id = v_proj;

  FOR f IN
    SELECT fld
    FROM jsonb_array_elements(v_schema->'sections') sec,
         jsonb_array_elements(sec->'fields') fld
    WHERE (fld->>'is_rollup')::boolean IS TRUE
       OR (fld->>'is_computed')::boolean IS TRUE
  LOOP
    v_patch := v_patch || jsonb_build_object(
      f->>'name',
      CASE COALESCE(f->>'rollup_kind', f->>'computed_kind')
        WHEN 'units_count'                   THEN to_jsonb(COALESCE(a.n, 0))
        WHEN 'units_available_count'         THEN to_jsonb(COALESCE(a.n_avail, 0))
        WHEN 'units_sold_count'              THEN to_jsonb(COALESCE(a.n_sold, 0))
        WHEN 'units_reserved_count'          THEN to_jsonb(COALESCE(a.n_res, 0))
        WHEN 'price_range'                   THEN public._rollup_range(a.price_min, a.price_max)
        WHEN 'area_range'                    THEN public._rollup_range(a.area_min, a.area_max)
        WHEN 'available_price_range'         THEN public._rollup_range(a.avail_price_min, a.avail_price_max)
        WHEN 'available_area_range'          THEN public._rollup_range(a.avail_area_min, a.avail_area_max)
        WHEN 'available_native_price_range'  THEN public._rollup_range(a.avail_native_price_min, a.avail_native_price_max)  -- NEW (W2)
        WHEN 'bedroom_range'                 THEN public._rollup_range(a.bed_min, a.bed_max)
        WHEN 'bathroom_range'                THEN public._rollup_range(a.bath_min, a.bath_max)
        WHEN 'min_price_per_meter'           THEN CASE WHEN a.ppm_min IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_min, 4)) END
        WHEN 'max_price_per_meter'           THEN CASE WHEN a.ppm_max IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_max, 4)) END
        WHEN 'avg_price_per_meter'           THEN CASE WHEN a.ppm_avg IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_avg, 4)) END
        ELSE 'null'::jsonb
      END
    );
  END LOOP;

  IF COALESCE(a.n, 0) > 0 THEN
    SELECT fld INTO v_ut_field
    FROM jsonb_array_elements(v_schema->'sections') sec,
         jsonb_array_elements(sec->'fields') fld
    WHERE (fld->>'auto_from_units')::boolean IS TRUE
    LIMIT 1;

    IF v_ut_field IS NOT NULL THEN
      v_ut_slug := v_ut_field->>'name';
      v_ut_opts := COALESCE(v_ut_field->'options', '[]'::jsonb);

      SELECT COALESCE(jsonb_agg(mapped ORDER BY mapped), '[]'::jsonb)
      INTO v_ut_types
      FROM (
        SELECT DISTINCT COALESCE(
          (SELECT o->>'value'
             FROM jsonb_array_elements(v_ut_opts) o
            WHERE lower(btrim(o->>'value'))    = lower(dr.raw)
               OR lower(btrim(o->>'label_en')) = lower(dr.raw)
               OR lower(btrim(o->>'label_ar')) = lower(dr.raw)
            LIMIT 1),
          dr.raw
        ) AS mapped
        FROM (
          SELECT DISTINCT btrim(u.data->>'unit_type') AS raw
          FROM public.records u
          WHERE u.model_id = v_units
            AND (
              u.data->>'project_id' = v_pid
              OR (jsonb_typeof(u.data->'project_id') = 'array' AND u.data->'project_id' ? v_pid)
            )
            AND btrim(COALESCE(u.data->>'unit_type', '')) <> ''
        ) dr
      ) m;

      v_patch := v_patch || jsonb_build_object(v_ut_slug, v_ut_types);
    END IF;
  END IF;

  RETURN v_patch;
END;
$fn$;

-- ────────────────────────────────────────────────────────────────────────
-- 2. Add the available_native_price_range field to the all_projects schema
--    (Inventory Summary section — cloned from available_price_range, fresh id,
--    show_in_table=false, read_only). Idempotent: skips if kind already exists.
-- ────────────────────────────────────────────────────────────────────────
DO $add$
DECLARE
  v_id uuid;
  v_schema jsonb;
  v_secs jsonb := '[]'::jsonb;
  v_sec jsonb;
  v_price jsonb;
  v_maxord numeric;
BEGIN
  SELECT id, schema INTO v_id, v_schema FROM public.models WHERE name = 'all_projects';
  IF v_id IS NULL THEN
    RAISE NOTICE 'all_projects not found — skip field add';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_schema->'sections') sec,
         jsonb_array_elements(COALESCE(sec->'fields','[]'::jsonb)) fld
    WHERE fld->>'rollup_kind' = 'available_native_price_range'
  ) THEN
    RAISE NOTICE 'available_native_price_range already present — skip field add';
    RETURN;
  END IF;

  FOR v_sec IN SELECT * FROM jsonb_array_elements(v_schema->'sections') LOOP
    SELECT f INTO v_price
    FROM jsonb_array_elements(COALESCE(v_sec->'fields','[]'::jsonb)) f
    WHERE f->>'rollup_kind' = 'available_price_range' LIMIT 1;

    IF v_price IS NOT NULL THEN
      SELECT COALESCE(max((f->>'order')::numeric), -1) INTO v_maxord
      FROM jsonb_array_elements(v_sec->'fields') f;

      v_sec := jsonb_set(
        v_sec, '{fields}',
        (v_sec->'fields') || jsonb_build_array(
          v_price || jsonb_build_object(
            'id', gen_random_uuid()::text,
            'name', 'available_native_price_range',
            'label_ar', 'نطاق سعر الوحدات المتاحة (عملة المطور)',
            'label_en', 'Available Price Range (Developer Currency)',
            'order', v_maxord + 1,
            'rollup_kind', 'available_native_price_range',
            'show_in_table', false
          )
        )
      );
    END IF;

    v_secs := v_secs || jsonb_build_array(v_sec);
    v_price := NULL;
  END LOOP;

  UPDATE public.models
  SET schema = jsonb_set(v_schema, '{sections}', v_secs), updated_at = now()
  WHERE id = v_id;
END $add$;

-- ────────────────────────────────────────────────────────────────────────
-- 3. Backfill: touch every all_projects row — the existing BEFORE-fill trigger
--    recomputes with the new function and stores the native range.
-- ────────────────────────────────────────────────────────────────────────
UPDATE public.records
SET data = data
WHERE model_id = public._rollups_all_projects_model_id();
