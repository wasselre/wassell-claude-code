-- D45: delete the developer_knowledge model.
--
-- A never-wired knowledge-base model — ZERO code references anywhere in
-- src/api/worker (grep-verified 2026-09-27). Unfrozen (is_system=false), 13
-- records. The per-model v_developer_knowledge view auto-drops via
-- models_view_sync on the model DELETE.
--
-- Applied live to wassell-prod 2026-09-27. Snapshot (recoverable):
--   _backup_developer_knowledge_model_20260927   (model def)
--   _backup_developer_knowledge_records_20260927 (13 records)
-- Restore = re-INSERT the model + records.

BEGIN;

CREATE TABLE public._backup_developer_knowledge_model_20260927 AS
  SELECT * FROM public.models WHERE name = 'developer_knowledge';

CREATE TABLE public._backup_developer_knowledge_records_20260927 AS
  SELECT * FROM public.records
  WHERE model_id IN (SELECT id FROM public._backup_developer_knowledge_model_20260927);

DELETE FROM public.records WHERE model_id IN (SELECT id FROM public._backup_developer_knowledge_model_20260927);
DELETE FROM public.models  WHERE name = 'developer_knowledge';

COMMIT;
