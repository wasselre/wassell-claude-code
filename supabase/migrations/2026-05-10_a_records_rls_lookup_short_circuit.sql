-- ============================================================================
-- Records-table RLS: short-circuit wassell_is_public_lookup_target so it
-- only runs when the record's model is actually a lookup target.
--
-- The 2026-05-09_n_public_lookup_targets policy had this third OR branch:
--
--   public.wassell_is_public_lookup_target(records.id, records.model_id)
--
-- which the planner invokes for EVERY row that didn't match the first two
-- branches — e.g. every all_projects record where is_public != true. For a
-- 1,366-project tenant that's 1,365 invocations of a function that EXISTS-
-- scans records × sections × fields. Result: 10s+ per anon SELECT, hitting
-- Supabase's 30s statement_timeout intermittently — the website map page
-- shows "تعذّر تحميل المشاريع" because every record fetch fails.
--
-- Fix: gate the third branch behind `model_id IN (lookup-target model ids)`
-- so the expensive function is invoked ONLY for records of a lookup-target
-- model (developers, etc.) — never for the bulk all_projects rows.
--
-- AND short-circuits in Postgres (planner-permitting), so this drops the
-- per-row cost from "function-call + EXISTS scan" to a constant-time list
-- check for non-target models. Cost on the lookup-target rows is unchanged.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "records_public_website_read" ON public.records;
CREATE POLICY "records_public_website_read"
  ON public.records FOR SELECT TO anon
  USING (
    -- site_settings is always readable.
    model_id IN (SELECT id FROM public.models WHERE name = 'site_settings')
    OR
    -- Published projects.
    (
      model_id IN (SELECT id FROM public.models WHERE name = 'all_projects')
      AND COALESCE((data->>'is_public')::boolean, false) = true
    )
    OR
    -- Lookup-target records, but only when the record's model is one of the
    -- known lookup-target models — short-circuits the expensive function on
    -- every non-target row.
    (
      model_id IN (SELECT * FROM public.wassell_public_lookup_model_ids())
      AND public.wassell_is_public_lookup_target(records.id, records.model_id)
    )
  );

COMMIT;
