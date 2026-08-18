-- ============================================================================
-- Phase 3 · B2A.3 — set-based file_links_select
--
-- PERFORMANCE ONLY. No D1 record-derived access, no new grants, no folder
-- change. files_select returns byte-identical id sets; file_links_select
-- returns byte-identical EDGE sets.
--
-- ── WHY, MEASURED ──────────────────────────────────────────────────────────
-- On a production-shaped ephemeral corpus (8,019 files / 7,019 edges):
--
--   file-visibility   wassell_can_access_file(file_id,'view')   7,353 ms
--   record-visibility EXISTS (unified_records ...)                  0.224 ms
--   B2 consumers      linked_model / role / link_count      7,363 / 7,412 / 63 ms
--
-- The record-visibility predicate is FREE and must not be touched. The entire
-- cost is the per-edge authorization function.
--
-- ── WHY NOT A COST HINT (tested, refuted) ──────────────────────────────────
-- Writing the two conjuncts by hand costs 6 ms, because the planner runs the
-- cheap one first. Declaring the function's true cost does NOT reproduce that
-- inside the policy: COST 100 -> 10000 moved the estimate 195,966 -> 369,686,
-- left the filter order byte-identical, and changed nothing across all seven
-- personas (worst 7,211 ms both ways). The record half compiles to a hashed
-- SubPlan, and PostgreSQL evaluates SubPlans AFTER ordinary quals regardless of
-- cost — so the expensive function is structurally guaranteed to run first. No
-- tuning fixes that; the predicate itself has to change.
--
-- ── THE DESIGN: ONE AUTHORITY, USED BY BOTH POLICIES ───────────────────────
-- wassell_my_visible_file_ids() becomes THE single definition of "which files
-- may I view". Both policies consume it:
--
--   files_select        id      IN (that set)
--   file_links_select   file_id IN (that set)  AND  <record visible>
--
-- The branch logic lives in exactly one place, so the two policies cannot
-- drift — the failure mode that writing the Files rules out a second time
-- inside file_links_select would have introduced.
--
-- ── WHY THIS IS RECURSION-SAFE FOR B4/D1 ───────────────────────────────────
-- The function is SECURITY DEFINER and reads BASE TABLES, so no RLS policy is
-- evaluated inside it. When D1 later makes file visibility depend on file_links,
-- that new branch reads public.file_links directly and still triggers no policy,
-- so file_links_select -> wassell_my_visible_file_ids() -> file_links cannot
-- become a policy cycle. Querying RLS-filtered `files` from file_links_select
-- would have created exactly that cycle, which is why it is not done.
--
-- ── BOTH-SIDED PRIVACY PRESERVED ───────────────────────────────────────────
-- An edge is visible only if the caller can see the FILE and the exact
-- (model_id, record_id) TARGET. The record half is carried over verbatim: it is
-- already free, and it is the half that enforces target privacy.
--
-- ── IDENTITY GUARD, EXPLICIT ───────────────────────────────────────────────
-- file_links_select currently inherits the guard implicitly from
-- wassell_can_access_file. The replacement states it at the top of both the
-- function and the policy, so removing it becomes a visible edit rather than an
-- accident. That is the B2A.1 lesson.
--
-- Rollback: supabase/rollback/2026-08-18_01_link_authz_set_based_down.sql
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_my_visible_file_ids()
RETURNS TABLE (file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $fn$
  SELECT f.id
    FROM public.files f
   WHERE public.wassell_app_user_id((SELECT auth.uid())) IS NOT NULL
     AND (
          public.wassell_is_admin((SELECT auth.uid()))
       OR f.uploaded_by_user_id = public.wassell_app_user_id((SELECT auth.uid()))
       OR f.id IN (SELECT g.file_id FROM public.wassell_my_granted_file_ids('view') g)
       OR (public.wassell_mos_can('read')
           AND f.id IN (SELECT m.file_id FROM public.wassell_my_marketing_file_ids() m))
       OR (f.folder_id IS NOT NULL
           AND f.folder_id IN (SELECT c.folder_id FROM public.wassell_my_cascade_folder_ids('view') c))
     )
$fn$;

DROP POLICY IF EXISTS files_select ON public.files;
CREATE POLICY files_select ON public.files FOR SELECT TO authenticated
USING (
  (SELECT public.wassell_app_user_id((SELECT auth.uid()))) IS NOT NULL
  AND id IN (SELECT v.file_id FROM public.wassell_my_visible_file_ids() v)
);

DROP POLICY IF EXISTS file_links_select ON public.file_links;
CREATE POLICY file_links_select ON public.file_links FOR SELECT TO authenticated
USING (
  (SELECT public.wassell_app_user_id((SELECT auth.uid()))) IS NOT NULL
  AND file_id IN (SELECT v.file_id FROM public.wassell_my_visible_file_ids() v)
  AND EXISTS (SELECT 1 FROM public.unified_records ur
               WHERE ur.id = file_links.record_id
                 AND ur.model_id = file_links.model_id)
);

DO $g$
BEGIN
  REVOKE ALL ON FUNCTION public.wassell_my_visible_file_ids() FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.wassell_my_visible_file_ids() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.wassell_my_visible_file_ids() TO authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION public.wassell_my_visible_file_ids() TO service_role;
  END IF;
END $g$;

COMMIT;
