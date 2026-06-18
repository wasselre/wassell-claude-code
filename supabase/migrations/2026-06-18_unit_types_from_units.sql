-- ============================================================================
-- all_projects.unit_types — derive from linked units when they exist.
--
-- BEHAVIOR (per request 2026-06-18):
--   • A project WITH linked units → `unit_types` is auto-calculated from the
--     distinct `unit_type` values of those units (deduplicated) and the form
--     renders it read-only (units are the source of truth).
--   • A project WITHOUT linked units → `unit_types` stays manually editable and
--     the user-entered value is preserved.
--
-- This rides on the EXISTING project-rollups machinery
-- (2026-06-15_persist_project_rollups.sql): the BEFORE INSERT/UPDATE trigger
-- `records_fill_project_rollups` already calls `recalc_project_rollups_data`
-- and merges the patch with `NEW.data || patch`. We make that function ALSO
-- emit `unit_types` — but ONLY when the project has ≥1 linked unit. When the
-- project has no units the key is OMITTED, so `data || patch` leaves the manual
-- value untouched. The AFTER trigger on units rows (`records_touch_project_on_
-- unit_change`) already re-touches the project on any unit change, so adding /
-- removing / retyping a unit recomputes `unit_types` automatically.
--
-- The frontend marks the field with `auto_from_units: true` (NOT `is_rollup`,
-- which would force read-only everywhere and exclude it from imports). The
-- form (src/pages/Records/components/SectionBlock.tsx) renders it read-only
-- per-record based on whether the project has linked units.
--
-- VALUE MAPPING: `units.unit_type` is a dropdown whose option VALUES are Arabic
-- (e.g. `شقة`, `فيلا`) while `all_projects.unit_types` is a multiselect whose
-- option VALUES are English slugs (`apartment`, `villa`). We map each raw unit
-- value onto the project field's own option whose value / label_en / label_ar
-- matches (case-insensitive, trimmed), so chips render with the correct label +
-- colour. An unmapped type falls back to its raw value (still shown by the
-- read-only cell, just without a colour) so nothing is silently dropped.
--
-- Idempotent. Safe to re-run. `all_projects` + `units` are UNFROZEN JSONB.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────
-- 1. On the all_projects.unit_types field (matched by slug):
--      a. set `auto_from_units: true`  (drives the derive + read-only behavior)
--      b. append a `penthouse` option if missing — the units carry a real
--         `بنتهاوس` (Penthouse) type that has no project option yet, so without
--         this it would render as a plain (colour-less) raw-value badge. Adding
--         it lets the derivation map `بنتهاوس` → `penthouse` (via label_ar) and
--         render a proper bilingual coloured chip. Existing options are NEVER
--         removed or altered. Idempotent on both counts.
-- ────────────────────────────────────────────────────────────────────────
DO $flag$
DECLARE
  v_id uuid;
  v_schema jsonb;
  v_secs jsonb := '[]'::jsonb;
  v_sec jsonb;
  v_flds jsonb;
  v_fld jsonb;
  v_opts jsonb;
  v_has_pent boolean;
BEGIN
  SELECT id, schema INTO v_id, v_schema FROM public.models WHERE name = 'all_projects';
  IF v_id IS NULL THEN RAISE NOTICE 'all_projects not found — skip'; RETURN; END IF;

  FOR v_sec IN SELECT * FROM jsonb_array_elements(v_schema->'sections') LOOP
    v_flds := '[]'::jsonb;
    FOR v_fld IN SELECT * FROM jsonb_array_elements(COALESCE(v_sec->'fields','[]'::jsonb)) LOOP
      IF v_fld->>'name' = 'unit_types' THEN
        v_fld := v_fld || jsonb_build_object('auto_from_units', true);
        v_opts := COALESCE(v_fld->'options', '[]'::jsonb);
        SELECT EXISTS (
          SELECT 1 FROM jsonb_array_elements(v_opts) o
          WHERE lower(o->>'value') = 'penthouse' OR btrim(o->>'label_ar') = 'بنتهاوس'
        ) INTO v_has_pent;
        IF NOT v_has_pent THEN
          v_fld := jsonb_set(v_fld, '{options}', v_opts || jsonb_build_array(jsonb_build_object(
            'id',       gen_random_uuid()::text,
            'label_ar', 'بنتهاوس',
            'label_en', 'Penthouse',
            'value',    'penthouse',
            'color',    '#06B6D4'
          )));
        END IF;
      END IF;
      v_flds := v_flds || jsonb_build_array(v_fld);
    END LOOP;
    v_sec := jsonb_set(v_sec, '{fields}', v_flds);
    v_secs := v_secs || jsonb_build_array(v_sec);
  END LOOP;

  UPDATE public.models
  SET schema = jsonb_set(v_schema, '{sections}', v_secs), updated_at = now()
  WHERE id = v_id;
END $flag$;

-- ────────────────────────────────────────────────────────────────────────
-- 2. Extend recalc_project_rollups_data to ALSO derive `unit_types` (the
--    only change vs 2026-06-15 is the conditional unit_types block at the
--    end — the eleven numeric/range rollups are byte-for-byte unchanged).
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

  -- One pass over the project's units → every aggregate the eleven kinds need.
  SELECT
    count(*)                                                                              AS n,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','available'))  AS n_avail,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','sold'))        AS n_sold,
    count(*) FILTER (WHERE public._rollup_status_is(u.data->>'unit_status','reserved'))    AS n_res,
    min(public.try_numeric(u.data->>'total_price'))                                        AS price_min,
    max(public.try_numeric(u.data->>'total_price'))                                        AS price_max,
    min(public.try_numeric(u.data->>'unit_area'))                                          AS area_min,
    max(public.try_numeric(u.data->>'unit_area'))                                          AS area_max,
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
        WHEN 'units_count'           THEN to_jsonb(COALESCE(a.n, 0))
        WHEN 'units_available_count' THEN to_jsonb(COALESCE(a.n_avail, 0))
        WHEN 'units_sold_count'      THEN to_jsonb(COALESCE(a.n_sold, 0))
        WHEN 'units_reserved_count'  THEN to_jsonb(COALESCE(a.n_res, 0))
        WHEN 'price_range'           THEN public._rollup_range(a.price_min, a.price_max)
        WHEN 'area_range'            THEN public._rollup_range(a.area_min, a.area_max)
        WHEN 'bedroom_range'         THEN public._rollup_range(a.bed_min, a.bed_max)
        WHEN 'bathroom_range'        THEN public._rollup_range(a.bath_min, a.bath_max)
        WHEN 'min_price_per_meter'   THEN CASE WHEN a.ppm_min IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_min, 4)) END
        WHEN 'max_price_per_meter'   THEN CASE WHEN a.ppm_max IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_max, 4)) END
        WHEN 'avg_price_per_meter'   THEN CASE WHEN a.ppm_avg IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_avg, 4)) END
        ELSE 'null'::jsonb
      END
    );
  END LOOP;

  -- Conditional rollup: derive `unit_types` from the linked units' distinct
  -- `unit_type` values — ONLY when the project has ≥1 linked unit. With no
  -- units the key is OMITTED so `data || patch` (BEFORE-fill trigger) leaves
  -- any manually-entered value intact. The DISTINCT set excludes empty values;
  -- each raw value is mapped onto the project field's own option (by value /
  -- label_en / label_ar, case-insensitive) so chips render with label+colour,
  -- with a raw-value fallback for any unit type that has no matching option.
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
-- 3. Backup + backfill. Touch every all_projects row → the BEFORE-fill
--    trigger re-derives unit_types for projects that have units. Projects
--    with no units are left exactly as they were (key omitted). NOTE: this
--    overwrites any MANUALLY-set unit_types on projects that DO have units —
--    intended (units are the source of truth) and recoverable from the backup.
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public._backup_all_projects_unit_types_20260618 AS
  SELECT id, data FROM public.records WHERE model_id = public._rollups_all_projects_model_id();

UPDATE public.records
SET data = data
WHERE model_id = public._rollups_all_projects_model_id();
