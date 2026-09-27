-- D48 + D04: delete two dead is_system models.
--   marketing_operations — legacy Higgsfield orchestration, already archived
--     (was in ARCHIVED_MODULE_MODELS), 3 records.
--   copywriter_chats — the retired reel-copywriter assistant
--     (was in RETIRED_ASSISTANT_MODELS), 17 records.
-- Both unfrozen (JSONB records); their v_<name> views auto-drop via
-- models_view_sync on model DELETE. is_system=true, but the schema-shrink guard
-- (models_guard_schema_shrink) is a browser-JWT UPDATE trigger — a service-role
-- DELETE is unaffected.
--
-- Applied live to wassell-prod 2026-09-27. Snapshot (recoverable):
--   _backup_dead_models_20260927        (2 model defs)
--   _backup_dead_model_records_20260927 (20 records)
-- The names were also removed from ARCHIVED_MODULE_MODELS / RETIRED_ASSISTANT_MODELS
-- in src/lib/featureFlags.ts. seedModels.ts still carries offline baselines (offline
-- mode only) — left as-is.

BEGIN;

CREATE TABLE public._backup_dead_models_20260927 AS
  SELECT * FROM public.models WHERE name IN ('marketing_operations','copywriter_chats');

CREATE TABLE public._backup_dead_model_records_20260927 AS
  SELECT * FROM public.records
  WHERE model_id IN (SELECT id FROM public._backup_dead_models_20260927);

DELETE FROM public.records WHERE model_id IN (SELECT id FROM public._backup_dead_models_20260927);
DELETE FROM public.models  WHERE name IN ('marketing_operations','copywriter_chats');

COMMIT;
