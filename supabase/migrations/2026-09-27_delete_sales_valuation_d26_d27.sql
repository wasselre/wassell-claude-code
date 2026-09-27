-- D26/D27: delete the Sales Valuation operation.
--
-- Removes the 5 models (تقييم المبيعات group) + all their records + the whole
-- svr_* trigger/function family that auto-created reviews from completed
-- follow-ups. All 5 models are unfrozen (is_system=false) → records live in
-- `records` (JSONB) and the per-model v_<name> views auto-drop via
-- models_view_sync on model DELETE. The svr_ triggers are AFTER-triggers on
-- `records`; dropping the functions CASCADE removes them.
--
-- Applied live to wassell-prod 2026-09-27. Snapshot (recoverable):
--   _backup_sv_models_20260927  (5 model defs)
--   _backup_sv_records_20260927 (1,792 records; 1,775 were sales_valuation_reviews)
--   _backup_sv_group_20260927   (the group row, id 5a1e7a10-…)
-- Restore: re-INSERT the model + group rows, the records, and re-run the svr_*
-- function/trigger migration.

BEGIN;

CREATE TABLE public._backup_sv_models_20260927 AS
  SELECT * FROM public.models
  WHERE name IN ('sales_valuation_reviews','sales_correction_tasks','sales_rep_daily_valuations','sales_mistake_categories','sales_valuation_settings');

CREATE TABLE public._backup_sv_records_20260927 AS
  SELECT * FROM public.records
  WHERE model_id IN (SELECT id FROM public._backup_sv_models_20260927);

CREATE TABLE public._backup_sv_group_20260927 AS
  SELECT * FROM public.model_groups WHERE id = '5a1e7a10-9700-4000-8000-000000000001';

-- Drop the whole svr_ function family CASCADE (removes the 5 dependent triggers
-- on public.records).
DO $sv$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT 'DROP FUNCTION IF EXISTS public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') CASCADE' AS cmd
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'svr\_%'
  LOOP
    EXECUTE r.cmd;
  END LOOP;
END $sv$;

DELETE FROM public.records      WHERE model_id IN (SELECT id FROM public._backup_sv_models_20260927);
DELETE FROM public.models       WHERE id       IN (SELECT id FROM public._backup_sv_models_20260927);
DELETE FROM public.model_groups WHERE id = '5a1e7a10-9700-4000-8000-000000000001';

COMMIT;
