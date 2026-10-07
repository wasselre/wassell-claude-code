-- Project finder: a client's amenities are matched against what the project's
-- UNITS contain, not only the project's own amenity list (operator, 2026-10-07).
--
-- Units already record this: `unit_components` (مجلس، غرفة خادمة، غرفة سائق،
-- سطح، فناء خارجي، مصعد…) on ~5,900 units, plus `elevator_status` and
-- `yard_area`. This adds ONE stored rollup on all_projects, `unit_features` —
-- the union over the project's AVAILABLE units — maintained by the existing
-- rollup trigger (recalc_project_rollups_data is the single implementation; the
-- units→project touch trigger already recomputes it on every unit change).
--
-- 1. recalc_project_rollups_data learns rollup_kind 'unit_components'
--    (re-emitted verbatim from the live definition + that one addition).
-- 2. all_projects gets the read-only rollup field in «Inventory Summary»,
--    options copied from units.unit_components so the form shows labels.
-- 3. Backfill: touch only the projects with an available unit that records any of it.

BEGIN;

CREATE OR REPLACE FUNCTION public.recalc_project_rollups_data(p_project_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_comp     jsonb;
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

  -- What the project's AVAILABLE units contain (2026-10-07): the union of their
  -- `unit_components` (مجلس، غرفة خادمة، غرفة سائق، سطح، فناء خارجي…), plus
  -- «مصعد» for a unit whose elevator is ready and «فناء خارجي» for a unit with a
  -- yard area. The project finder matches a client's amenities against it.
  -- JSON null = no available unit records any of it (unknown, not «none»).
  SELECT jsonb_agg(DISTINCT c.v ORDER BY c.v)
  INTO v_comp
  FROM public.records u
  CROSS JOIN LATERAL (
    SELECT btrim(x) AS v
      FROM jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(u.data->'unit_components') = 'array' THEN u.data->'unit_components' ELSE '[]'::jsonb END) x
    UNION ALL
    SELECT 'مصعد' WHERE btrim(COALESCE(u.data->>'elevator_status', '')) = 'جاهز'
    UNION ALL
    SELECT 'فناء خارجي' WHERE public.try_numeric(u.data->>'yard_area') > 0
  ) c
  WHERE u.model_id = v_units
    AND (
      u.data->>'project_id' = v_pid
      OR (jsonb_typeof(u.data->'project_id') = 'array' AND u.data->'project_id' ? v_pid)
    )
    AND public._rollup_status_is(u.data->>'unit_status', 'available')
    AND c.v <> '';

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
        WHEN 'available_native_price_range'  THEN public._rollup_range(a.avail_native_price_min, a.avail_native_price_max)
        WHEN 'bedroom_range'                 THEN public._rollup_range(a.bed_min, a.bed_max)
        WHEN 'bathroom_range'                THEN public._rollup_range(a.bath_min, a.bath_max)
        WHEN 'min_price_per_meter'           THEN CASE WHEN a.ppm_min IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_min, 4)) END
        WHEN 'max_price_per_meter'           THEN CASE WHEN a.ppm_max IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_max, 4)) END
        WHEN 'avg_price_per_meter'           THEN CASE WHEN a.ppm_avg IS NULL THEN 'null'::jsonb ELSE to_jsonb(round(a.ppm_avg, 4)) END
        WHEN 'unit_components'               THEN COALESCE(v_comp, 'null'::jsonb)
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
$function$;

DO $$
DECLARE
  v_proj uuid := public._rollups_all_projects_model_id();
  v_schema jsonb;
  v_idx int;
  v_opts jsonb;
BEGIN
  SELECT schema INTO v_schema FROM public.models WHERE id = v_proj;
  IF EXISTS (SELECT 1 FROM jsonb_path_query(v_schema, '$.sections[*].fields[*]') f WHERE f->>'name' = 'unit_features') THEN
    RAISE NOTICE 'unit_features already present';
    RETURN;
  END IF;
  SELECT (ord - 1)::int INTO v_idx
    FROM jsonb_array_elements(v_schema->'sections') WITH ORDINALITY t(s, ord)
   WHERE s->>'label_en' = 'Inventory Summary';
  IF v_idx IS NULL THEN RAISE EXCEPTION 'Inventory Summary section not found on all_projects'; END IF;
  SELECT f->'options' INTO v_opts
    FROM public.models m, jsonb_path_query(m.schema, '$.sections[*].fields[*]') f
   WHERE m.name = 'units' AND f->>'name' = 'unit_components';
  UPDATE public.models
     SET schema = jsonb_set(schema, ARRAY['sections', v_idx::text, 'fields'],
       (schema->'sections'->v_idx->'fields') || jsonb_build_array(jsonb_build_object(
         'id', gen_random_uuid()::text,
         'name', 'unit_features',
         'label_ar', 'مكونات الوحدات المتاحة',
         'label_en', 'Available Unit Features',
         'type', 'multiselect',
         'required', false,
         'order', jsonb_array_length(schema->'sections'->v_idx->'fields'),
         'section_id', schema->'sections'->v_idx->>'id',
         'width', 'full',
         'show_in_table', false,
         'is_rollup', true,
         'rollup_kind', 'unit_components',
         'read_only', true,
         'options', COALESCE(v_opts, '[]'::jsonb),
         'lookup_model_id', null,
         'lookup_display_field', null)))
   WHERE id = v_proj;
END $$;

-- Backfill (the BEFORE trigger recomputes on the touch). Only projects with an
-- AVAILABLE unit that records something are written — found from the units
-- side in one pass (calling the recalc per project to decide timed out).
UPDATE public.records r
   SET data = r.data
 WHERE r.model_id = public._rollups_all_projects_model_id()
   AND r.id::text IN (
     SELECT DISTINCT public._rollup_project_id_of(u.data)
       FROM public.records u
      WHERE u.model_id = public._rollups_units_model_id()
        AND public._rollup_status_is(u.data->>'unit_status', 'available')
        AND (
          (jsonb_typeof(u.data->'unit_components') = 'array' AND jsonb_array_length(u.data->'unit_components') > 0)
          OR btrim(COALESCE(u.data->>'elevator_status', '')) = 'جاهز'
          OR public.try_numeric(u.data->>'yard_area') > 0
        )
   );

COMMIT;
