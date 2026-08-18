-- ============================================================================
-- Client preference ranges — new bounds + option ladders
-- (clients.preferred_area, clients.budget).
--
-- Supersedes the ladders installed by 2026-06-17_client_range_dropdowns.sql
-- (and by scripts/build-client-range-dropdowns.mjs, which generated it — do NOT
-- re-run that script; it would overwrite these ladders with the old ones).
--
--   preferred_area (م²): 50 → 5,000 with NON-UNIFORM increments —
--                        10 m² from 50 to 500, then 100 m² from 500 to 5,000.
--                        91 ladder values.
--   budget (ر.س):        500,000 → 10,000,000 in uniform 50,000 steps.
--                        191 ladder values.
--
-- HOW THE NON-UNIFORM STEP IS EXPRESSED (and why no code change is needed):
-- a `range` field carries a single numeric `range_step`, which cannot describe
-- a two-rate ladder. It also does not have to: `range_step` is Builder-editor
-- metadata only — src/pages/Records/components/RangeField.tsx never reads
-- range_min/range_max/range_step. What the renderer DOES read is
-- `field.options`: a non-empty option list turns the min/max inputs into two
-- <select> pickers whose values are numeric strings. So the option ladder IS
-- the step specification, and it can encode any increment schedule.
-- range_min / range_max / range_step are still updated here so the Builder's
-- range editor tells the truth (`range_step` = the FINEST step in the ladder:
-- 10 m² / 50,000 ر.س — a divisor of every coarser step).
--
-- Every surface that edits these fields (the clients record form, the Clients
-- Preferences tab, the Follow-Ups preference panels, the Project Finder filter
-- pickers) renders them through DynamicField → RangeField off the live model
-- schema, so this one schema change applies everywhere. No site hardcodes
-- bounds.
--
-- SAFETY: stored record values stay {min,max} NUMERIC — the storage shape does
-- not change, so v_clients.{budget_min,budget_max,preferred_area_min,
-- preferred_area_max}, the matching engine (src/lib/matching/requirements.ts),
-- exports and analytics are unaffected. Records whose stored value is off the
-- new ladder KEEP their value: RangeField renders an extra <option> for an
-- unknown current value. Verified on prod before applying: of 727 client
-- records, 0 have a budget or area value outside the new bounds, and 3 have an
-- area value off the new ladder (e.g. 750 m²) — all preserved, none rewritten.
--
-- Idempotent: the UPDATE (and therefore the models_view_sync →
-- regenerate_model_view refresh) only runs when the JSONB actually changed.
-- ============================================================================

DO $$
DECLARE
  v_id       uuid;
  v_frozen   boolean;
  v_schema   jsonb;
  v_original jsonb;
  v_budget   jsonb;
  v_area     jsonb;
  s int;
  f int;
  v_name text;
  v_path text[];
BEGIN
  SELECT id, schema, COALESCE(is_hardcoded, false)
    INTO v_id, v_schema, v_frozen
    FROM public.models WHERE name = 'clients';

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'clients model not found';
  END IF;

  -- Fail LOUDLY rather than half-apply: a frozen clients model would also need
  -- the view-chain unwind + regenerate_frozen_model_artifacts (see CLAUDE.md).
  IF v_frozen THEN
    RAISE EXCEPTION 'clients is frozen (is_hardcoded=true) — this migration does not perform the frozen-model view-chain unwind; rewrite it per CLAUDE.md before running';
  END IF;

  -- Ladders. Option `value` is a NUMERIC string; labels carry thousands
  -- separators and are identical in both languages (the unit suffix — م² / ر.س
  -- — is appended by the renderer from range_unit_ar / range_unit_en).
  -- Option ids are deterministic (`<prefix>_<value>`) so re-running this
  -- migration cannot produce id drift for an unchanged value.
  SELECT jsonb_agg(
           jsonb_build_object(
             'id',       'area_opt_' || v,
             'label_ar', to_char(v, 'FM999,999,999'),
             'label_en', to_char(v, 'FM999,999,999'),
             'value',    v::text
           ) ORDER BY v
         )
    INTO v_area
    FROM (
      SELECT generate_series(50, 500, 10) AS v   -- 10 m² steps: 50 … 500
      UNION
      SELECT generate_series(500, 5000, 100)     -- 100 m² steps: 500 … 5,000
    ) t;

  SELECT jsonb_agg(
           jsonb_build_object(
             'id',       'budget_opt_' || v,
             'label_ar', to_char(v, 'FM999,999,999'),
             'label_en', to_char(v, 'FM999,999,999'),
             'value',    v::text
           ) ORDER BY v
         )
    INTO v_budget
    FROM generate_series(500000, 10000000, 50000) AS t(v);  -- uniform 50,000 steps

  IF jsonb_array_length(v_area) <> 91 OR jsonb_array_length(v_budget) <> 191 THEN
    RAISE EXCEPTION 'ladder generation produced % area / % budget values (expected 91 / 191)',
      jsonb_array_length(v_area), jsonb_array_length(v_budget);
  END IF;

  v_original := v_schema;

  -- Target fields BY NAME (robust to section/field reordering), never by index.
  FOR s IN 0 .. jsonb_array_length(v_schema->'sections') - 1 LOOP
    FOR f IN 0 .. jsonb_array_length(v_schema->'sections'->s->'fields') - 1 LOOP
      v_name := v_schema #>> ARRAY['sections', s::text, 'fields', f::text, 'name'];
      v_path := ARRAY['sections', s::text, 'fields', f::text];

      IF v_name = 'budget' THEN
        v_schema := jsonb_set(v_schema, v_path, (v_schema #> v_path) || jsonb_build_object(
          'options',    v_budget,
          'range_min',  500000,
          'range_max',  10000000,
          'range_step', 50000
        ), true);

      ELSIF v_name = 'preferred_area' THEN
        v_schema := jsonb_set(v_schema, v_path, (v_schema #> v_path) || jsonb_build_object(
          'options',    v_area,
          'range_min',  50,
          'range_max',  5000,
          'range_step', 10
        ), true);
      END IF;
    END LOOP;
  END LOOP;

  IF v_schema IS NOT DISTINCT FROM v_original THEN
    RAISE NOTICE 'clients budget/preferred_area ranges already current — no write, no view refresh';
    RETURN;
  END IF;

  -- One-time backup of the pre-change model row (skipped if it already exists).
  CREATE TABLE IF NOT EXISTS public._backup_clients_model_20260818 AS
    SELECT * FROM public.models WHERE name = 'clients';

  -- Updating models.schema fires models_view_sync → v_clients is regenerated.
  UPDATE public.models SET schema = v_schema, updated_at = now() WHERE id = v_id;

  RAISE NOTICE 'clients ranges applied — budget % ladder values, preferred_area % ladder values',
    jsonb_array_length(v_budget), jsonb_array_length(v_area);
END $$;
