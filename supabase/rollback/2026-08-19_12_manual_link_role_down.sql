-- ============================================================================
-- Rollback for supabase/migrations/2026-08-19_12_manual_link_role.sql
--
-- Restores the hardcoded 'supporting_document' literal in BOTH the global
-- derivation and its scoped twin. They must be reverted TOGETHER, or Phase 2's
-- equality proof (global == the union of scoped over every target) fails on the
-- next CI run.
--
-- Both bodies below are the EXACT pre-migration texts, captured from
-- pg_get_functiondef on production before the change was applied. Nothing is
-- hand-retyped: a rollback that silently alters the derivation while claiming
-- to restore it would be far worse than having no rollback at all.
--
-- -- WHAT THIS COSTS -------------------------------------------------------
-- Any manual link created while the migration was live and carrying a non-NULL
-- `role` will assert 'supporting_document' again afterwards. Because role is
-- part of edge identity (file_links_identity is UNIQUE on file_id, model_id,
-- record_id, role), the next convergence of those targets DELETES the
-- specific-role edge and creates a supporting_document one. The relationship
-- survives; the asserted type does not.
--
-- Check first -- zero means this rollback is a pure no-op:
--     SELECT count(*) FROM public.document_links WHERE role IS NOT NULL;
-- It was zero when the migration was applied on 2026-08-20.
--
-- The `document_links.role` COLUMN is deliberately untouched: it belongs to B1,
-- not to this migration, and dropping it is not part of reverting this change.
--
-- Idempotent (CREATE OR REPLACE).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.file_link_live_sources()
 RETURNS TABLE(source_key text, origin text, file_id uuid, model_id uuid, record_id uuid, role text, source_field text, source_position integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH field_valid AS (
    SELECT o.model_id, o.record_id, o.raw_value::uuid AS file_id, o.field,
           o.source_position, o.role
      FROM public.file_link_field_occurrences() o
     WHERE o.class = 'file'
  ),
  tri AS (
    SELECT fv.file_id, fv.model_id, fv.record_id,
           count(DISTINCT fv.role) AS n_roles,
           min(fv.role)            AS only_role
      FROM field_valid fv
     GROUP BY 1,2,3
  )
  SELECT 'field:'||fv.model_id||':'||fv.record_id||':'||fv.field||':'||fv.source_position||':'||fv.file_id,
         'field', fv.file_id, fv.model_id, fv.record_id, fv.role, fv.field, fv.source_position
    FROM field_valid fv
  UNION ALL
  SELECT 'attachment:'||fi.id||':'||fi.model_id||':'||fi.record_id,
         'attachment', fi.id, fi.model_id, fi.record_id,
         CASE WHEN t.n_roles = 1 THEN t.only_role ELSE 'attachment' END,
         NULL, NULL
    FROM public.files fi
    LEFT JOIN tri t
      ON t.file_id = fi.id AND t.model_id = fi.model_id AND t.record_id = fi.record_id
   WHERE fi.record_id IS NOT NULL AND fi.model_id IS NOT NULL
  UNION ALL
  SELECT 'manual:'||dl.file_id||':'||dl.model_id||':'||dl.record_id,
         'manual', dl.file_id, dl.model_id, dl.record_id,
         'supporting_document', NULL, NULL
    FROM public.document_links dl
   WHERE dl.model_id IS NOT NULL AND dl.record_id IS NOT NULL AND dl.file_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = dl.file_id)
  UNION ALL
  SELECT 'marketing:'||a.id||':'||a.file_id||':'||mp.id||':'||a.project_id,
         'marketing', a.file_id, mp.id, a.project_id, 'marketing_asset', NULL, NULL
    FROM public.mos_assets a
    CROSS JOIN LATERAL (SELECT id FROM public.models WHERE name='all_projects') mp
   WHERE a.file_id IS NOT NULL AND a.project_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = a.file_id);
$function$
;

CREATE OR REPLACE FUNCTION public.file_link_live_sources_scoped(p_model_id uuid, p_record_id uuid)
 RETURNS TABLE(source_key text, origin text, file_id uuid, model_id uuid, record_id uuid, role text, source_field text, source_position integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET jit TO 'off'
AS $function$
  WITH field_valid AS (
    SELECT o.model_id, o.record_id, o.raw_value::uuid AS file_id, o.field,
           o.source_position, o.role
      FROM public.file_link_field_occurrences_scoped(p_model_id, p_record_id) o
     WHERE o.class = 'file'
  ),
  tri AS (
    SELECT fv.file_id, fv.model_id, fv.record_id,
           count(DISTINCT fv.role) AS n_roles,
           min(fv.role)            AS only_role
      FROM field_valid fv
     GROUP BY 1,2,3
  )
  SELECT 'field:'||fv.model_id||':'||fv.record_id||':'||fv.field||':'||fv.source_position||':'||fv.file_id,
         'field', fv.file_id, fv.model_id, fv.record_id, fv.role, fv.field, fv.source_position
    FROM field_valid fv
  UNION ALL
  SELECT 'attachment:'||fi.id||':'||fi.model_id||':'||fi.record_id,
         'attachment', fi.id, fi.model_id, fi.record_id,
         CASE WHEN t.n_roles = 1 THEN t.only_role ELSE 'attachment' END,
         NULL, NULL
    FROM public.files fi
    LEFT JOIN tri t
      ON t.file_id = fi.id AND t.model_id = fi.model_id AND t.record_id = fi.record_id
   WHERE fi.record_id IS NOT NULL AND fi.model_id IS NOT NULL
     AND fi.model_id  = p_model_id
     AND fi.record_id = p_record_id
  UNION ALL
  SELECT 'manual:'||dl.file_id||':'||dl.model_id||':'||dl.record_id,
         'manual', dl.file_id, dl.model_id, dl.record_id,
         'supporting_document', NULL, NULL
    FROM public.document_links dl
   WHERE dl.model_id IS NOT NULL AND dl.record_id IS NOT NULL AND dl.file_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = dl.file_id)
     AND dl.model_id  = p_model_id
     AND dl.record_id = p_record_id
  UNION ALL
  SELECT 'marketing:'||a.id||':'||a.file_id||':'||mp.id||':'||a.project_id,
         'marketing', a.file_id, mp.id, a.project_id, 'marketing_asset', NULL, NULL
    FROM public.mos_assets a
    CROSS JOIN LATERAL (SELECT id FROM public.models WHERE name='all_projects') mp
   WHERE a.file_id IS NOT NULL AND a.project_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.files f WHERE f.id = a.file_id)
     AND mp.id        = p_model_id
     AND a.project_id = p_record_id;
$function$
;

COMMIT;
