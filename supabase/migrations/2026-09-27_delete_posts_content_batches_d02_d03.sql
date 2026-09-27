-- D02/D03: delete the marketing Posts feature (posts_content + posts_batches).
--
-- Both is_system=true (a service-role DELETE bypasses the browser-JWT
-- schema-shrink guard). posts_content carried the pair:body/headline/prose/spec
-- translation-twin policies (scope_id 9051c0d7-1a2b-4c3d-8e4f-000000000000, its
-- model id) — removed here; chat_templates' pair:body
-- (scope_id 4a70d8f1-2a6a-4ea7-b7ef-45c6e6af732b) is UNTOUCHED. Twins materialize
-- into physical _en/_ar columns, so there are ZERO translation_units to clean
-- (verified: 0 for posts_content). The `wassell.system_write` GUC makes
-- tg_records_enqueue_translation skip the record deletes. The v_<name> views
-- auto-drop via models_view_sync on model DELETE.
--
-- Applied live to wassell-prod 2026-09-27. Snapshots (recoverable):
--   _backup_posts_models_20260927        (2 model defs)
--   _backup_posts_records_20260927       (35 records: 32 posts_content + 3 posts_batches)
--   _backup_posts_twin_policies_20260927 (4 translation_field_policies rows)
-- Code removed: /marketing/posts route + posts_content customPages entry +
-- src/pages/PostsContent/* + its persistence test.

BEGIN;
SET LOCAL wassell.system_write = 'posts_delete_d02_d03';

CREATE TABLE public._backup_posts_models_20260927 AS
  SELECT * FROM public.models WHERE name IN ('posts_content','posts_batches');
CREATE TABLE public._backup_posts_records_20260927 AS
  SELECT * FROM public.records WHERE model_id IN (SELECT id FROM public._backup_posts_models_20260927);
CREATE TABLE public._backup_posts_twin_policies_20260927 AS
  SELECT * FROM public.translation_field_policies
  WHERE scope_id::text = '9051c0d7-1a2b-4c3d-8e4f-000000000000' AND field_path LIKE 'pair:%';

DELETE FROM public.translation_field_policies
  WHERE scope_id::text = '9051c0d7-1a2b-4c3d-8e4f-000000000000' AND field_path LIKE 'pair:%';

DELETE FROM public.records WHERE model_id IN (SELECT id FROM public._backup_posts_models_20260927);
DELETE FROM public.models  WHERE name IN ('posts_content','posts_batches');

COMMIT;
