-- ============================================================================
-- Phase 3 · B6 — a manual link may assert its own document type
--
-- B1 added `document_links.role` and described it precisely:
--
--     "Document type asserted by the person who made the manual link.
--      NULL = supporting_document."
--
-- The projection never learned to read it. `file_link_live_sources` (and its
-- scoped twin) hardcode the literal 'supporting_document' for every manual
-- link, so the column has been write-only since B1 shipped. B6 is the batch
-- that gives a person a way to set it — the "Attach existing" picker has a
-- document-type selector — and without this change that selector is a lie:
-- measured live on 2026-08-20, attaching a file as "brochure" wrote
-- role='brochure' to document_links and produced an edge with
-- role='supporting_document', so the panel filed it under the wrong heading.
--
-- ── WHY THIS IS SAFE ON EXISTING DATA ──────────────────────────────────────
-- All 10 manual links on production carry role = NULL, so
-- coalesce(dl.role,'supporting_document') is byte-identical to the literal it
-- replaces for every row that exists today. The change can only affect links
-- created AFTER it, by someone who deliberately picked a type. Verified by the
-- smoke below, which asserts the projection is unchanged before/after.
--
-- ── WHY BOTH FUNCTIONS, AND WHY RE-EMITTED VERBATIM ────────────────────────
-- Phase 2 deliberately keeps TWO texts — a global derivation and a scoped twin
-- — because an optional scope cannot be planned as an equality probe and
-- measured 400x slower. The drift risk between them is managed by an
-- executable proof: part 2 of the sync smoke asserts on every CI run that the
-- global function equals the union of the scoped function over every target.
-- A change to one and not the other breaks that proof, so BOTH are changed
-- here, identically.
--
-- Both bodies below are re-emitted VERBATIM from the LIVE definitions
-- (pg_get_functiondef on production, 2026-08-20) with exactly one edit each:
-- the literal becomes a coalesce. Nothing else in either text was retyped.
--
-- ── ROLE IS PART OF EDGE IDENTITY ──────────────────────────────────────────
-- `file_links_identity` is UNIQUE on (file_id, model_id, record_id, role), so
-- changing the role a source asserts moves it to a DIFFERENT edge. For a link
-- created after this migration that is simply the right edge from the start.
-- For an existing link it would mean convergence deleting one edge and
-- creating another — which is precisely why this migration is a no-op on the
-- current corpus, and why it must not be extended to rewrite existing roles.
--
-- Idempotent (CREATE OR REPLACE).
-- Rollback: supabase/rollback/2026-08-19_12_manual_link_role_down.sql
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
         coalesce(dl.role, 'supporting_document'), NULL, NULL
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
         coalesce(dl.role, 'supporting_document'), NULL, NULL
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
