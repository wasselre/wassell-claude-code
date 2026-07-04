-- ============================================================================
-- QA-003 — Available-unit price/area ranges, separate from the all-unit ranges.
--
-- The stored all_projects rollups `price_range` / `area_range` aggregate over
-- ALL linked units — including sold and reserved ones. Customer-facing outputs
-- (WhatsApp project messages, the public website, AI agents) were quoting a
-- project "starting price" that could belong to a unit nobody can buy anymore.
--
-- This migration adds TWO new stored rollups, computed over units whose
-- unit_status matches the AVAILABLE matcher only (bilingual substring match in
-- _rollup_status_is — 'available' / 'متاح' / 'متاحة'; reserved and sold units
-- are excluded):
--   • available_price_range  {min,max}  — rollup_kind 'available_price_range'
--   • available_area_range   {min,max}  — rollup_kind 'available_area_range'
--
-- The existing all-unit ranges are UNCHANGED — internal/admin surfaces keep
-- reading them. A project with zero available units gets JSON null for both
-- new fields (same convention as the all-unit ranges with zero units), so
-- customer-facing composers OMIT the price/area line instead of quoting a
-- sold unit's price.
--
-- Same architecture as 2026-06-15_persist_project_rollups.sql: the function
-- below REPLACES the live recalc_project_rollups_data (this version is based
-- on the LIVE definition, which also carries the auto_from_units unit-types
-- block added after 2026-06-15); the existing BEFORE-fill trigger on records
-- picks it up unchanged; the backfill at the end touches every all_projects
-- row so the new values are stored immediately.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

-- 0. Backup the all_projects model row before mutating its schema JSONB.
CREATE TABLE IF NOT EXISTS public._backup_models_all_projects_20260704 AS
  SELECT * FROM public.models WHERE name = 'all_projects';

-- ────────────────────────────────────────────────────────────────────────
-- 1. Extend the rollup recompute with available-only price/area aggregates.
--    (Full function — replaces the live definition; only the four
--    avail_* aggregates and the two new CASE branches are new.)
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
    -- Available-only price/area bounds (QA-003). min/max ignore NULL prices;
    -- a project with no available units yields NULL bounds → JSON null.
    min(public.try_numeric(u.data->>'total_price'))
      FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))          AS avail_price_min,
    max(public.try_numeric(u.data->>'total_price'))
      FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))          AS avail_price_max,
    min(public.try_numeric(u.data->>'unit_area'))
      FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))          AS avail_area_min,
    max(public.try_numeric(u.data->>'unit_area'))
      FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))          AS avail_area_max,
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
        WHEN 'units_count'            THEN to_jsonb(COALESCE(a.n, 0))
        WHEN 'units_available_count'  THEN to_jsonb(COALESCE(a.n_avail, 0))
        WHEN 'units_sold_count'       THEN to_jsonb(COALESCE(a.n_sold, 0))
        WHEN 'units_reserved_count'   THEN to_jsonb(COALESCE(a.n_res, 0))
        WHEN 'price_range'            THEN public._rollup_range(a.price_min, a.price_max)
        WHEN 'area_range'             THEN public._rollup_range(a.area_min, a.area_max)
        WHEN 'available_price_range'  THEN public._rollup_range(a.avail_price_min, a.avail_price_max)
        WHEN 'available_area_range'   THEN public._rollup_range(a.avail_area_min, a.avail_area_max)
        WHEN 'bedroom_range'          THEN public._rollup_range(a.bed_min, a.bed_max)
        WHEN 'bathroom_range'         THEN public._rollup_range(a.bath_min, a.bath_max)
        WHEN 'min_price_per_meter'    THEN CASE WHEN a.ppm_min IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_min, 4)) END
        WHEN 'max_price_per_meter'    THEN CASE WHEN a.ppm_max IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_max, 4)) END
        WHEN 'avg_price_per_meter'    THEN CASE WHEN a.ppm_avg IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_avg, 4)) END
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
-- 2. Add the two new rollup fields to the all_projects schema (Inventory
--    Summary section — same section as the existing rollups). Each new field
--    is CLONED from its all-unit sibling (keeps section_id / width / range
--    units / read_only flags) with a fresh id, new slug/labels/kind, and
--    show_in_table=false. Idempotent: skips if the kind already exists.
--    The models_view_sync trigger regenerates v_all_projects automatically.
-- ────────────────────────────────────────────────────────────────────────
DO $add$
DECLARE
  v_id uuid;
  v_schema jsonb;
  v_secs jsonb := '[]'::jsonb;
  v_sec jsonb;
  v_price jsonb;
  v_area jsonb;
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
    WHERE fld->>'rollup_kind' = 'available_price_range'
  ) THEN
    RAISE NOTICE 'available rollup fields already present — skip field add';
    RETURN;
  END IF;

  FOR v_sec IN SELECT * FROM jsonb_array_elements(v_schema->'sections') LOOP
    SELECT f INTO v_price
    FROM jsonb_array_elements(COALESCE(v_sec->'fields','[]'::jsonb)) f
    WHERE f->>'rollup_kind' = 'price_range' LIMIT 1;

    IF v_price IS NOT NULL THEN
      SELECT f INTO v_area
      FROM jsonb_array_elements(v_sec->'fields') f
      WHERE f->>'rollup_kind' = 'area_range' LIMIT 1;
      IF v_area IS NULL THEN v_area := v_price; END IF;

      SELECT COALESCE(max((f->>'order')::numeric), -1) INTO v_maxord
      FROM jsonb_array_elements(v_sec->'fields') f;

      v_sec := jsonb_set(
        v_sec, '{fields}',
        (v_sec->'fields') || jsonb_build_array(
          v_price || jsonb_build_object(
            'id', gen_random_uuid()::text,
            'name', 'available_price_range',
            'label_ar', 'نطاق سعر الوحدات المتاحة',
            'label_en', 'Available Price Range',
            'order', v_maxord + 1,
            'rollup_kind', 'available_price_range',
            'show_in_table', false
          ),
          v_area || jsonb_build_object(
            'id', gen_random_uuid()::text,
            'name', 'available_area_range',
            'label_ar', 'نطاق مساحة الوحدات المتاحة',
            'label_en', 'Available Area Range',
            'order', v_maxord + 2,
            'rollup_kind', 'available_area_range',
            'show_in_table', false
          )
        )
      );
    END IF;

    v_secs := v_secs || jsonb_build_array(v_sec);
    v_price := NULL;
    v_area := NULL;
  END LOOP;

  UPDATE public.models
  SET schema = jsonb_set(v_schema, '{sections}', v_secs), updated_at = now()
  WHERE id = v_id;
END $add$;

-- ────────────────────────────────────────────────────────────────────────
-- 3. Backfill: touch every all_projects row — the BEFORE-fill trigger
--    recomputes with the new function and stores the two new ranges.
-- ────────────────────────────────────────────────────────────────────────
UPDATE public.records
SET data = data
WHERE model_id = public._rollups_all_projects_model_id();
