-- Per-profile READ access to the workflow subsystem.
--
-- The Sales Process Studio (a non-model page now grantable per profile via
-- page_access) reads workflows from the store to show each phase's linked
-- workflow. But workflows / workflow_groups / workflow_runs were admin-only at
-- the DB (single FOR ALL policy USING wassell_is_admin), so a non-admin granted
-- the Studio loaded ZERO workflow rows and saw every activity as "Missing
-- workflow." This adds an opt-in, read-only workflow grant.
--
-- - New profiles.can_view_workflows flag (default false → no change for anyone).
-- - New wassell_can_view_workflows(uid): admin OR profile.can_view_workflows.
-- - workflows + workflow_groups: the FOR ALL admin policy is split into
--   per-command policies so SELECT is gated by can-view (read-only for granted
--   non-admins) while INSERT/UPDATE/DELETE stay admin-only (editing the Builder
--   remains admin-only). Splitting also keeps exactly one permissive SELECT
--   policy (2026-05-07 B.4 posture).
-- - workflow_runs_read: gated by can-view too (read-only run history). insert
--   stays open (client-side run logging), modify/delete stay admin.
--
-- Idempotent. Additive + safe to run on prod before the frontend deploy.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS can_view_workflows BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.wassell_can_view_workflows(auth_user_id UUID)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((
    SELECT p.is_admin OR COALESCE(p.can_view_workflows, false) FROM profiles p
      JOIN users u ON u.profile_id = p.id
     WHERE u.auth_uid = auth_user_id AND u.is_active = true LIMIT 1
  ), false);
$$;

-- Functions default-grant EXECUTE to PUBLIC; strip + grant explicitly (B.1/B.2).
REVOKE EXECUTE ON FUNCTION public.wassell_can_view_workflows(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wassell_can_view_workflows(uuid) TO authenticated;

-- workflows: split FOR ALL → per-command; SELECT now allows can-view.
DROP POLICY IF EXISTS "workflows_admin"  ON public.workflows;
DROP POLICY IF EXISTS "workflows_select" ON public.workflows;
DROP POLICY IF EXISTS "workflows_insert" ON public.workflows;
DROP POLICY IF EXISTS "workflows_update" ON public.workflows;
DROP POLICY IF EXISTS "workflows_delete" ON public.workflows;
CREATE POLICY "workflows_select" ON public.workflows FOR SELECT TO authenticated USING (public.wassell_can_view_workflows((SELECT auth.uid())));
CREATE POLICY "workflows_insert" ON public.workflows FOR INSERT TO authenticated WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "workflows_update" ON public.workflows FOR UPDATE TO authenticated USING (public.wassell_is_admin((SELECT auth.uid()))) WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "workflows_delete" ON public.workflows FOR DELETE TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())));

-- workflow_groups: same split.
DROP POLICY IF EXISTS "workflow_groups_admin"  ON public.workflow_groups;
DROP POLICY IF EXISTS "workflow_groups_select" ON public.workflow_groups;
DROP POLICY IF EXISTS "workflow_groups_insert" ON public.workflow_groups;
DROP POLICY IF EXISTS "workflow_groups_update" ON public.workflow_groups;
DROP POLICY IF EXISTS "workflow_groups_delete" ON public.workflow_groups;
CREATE POLICY "workflow_groups_select" ON public.workflow_groups FOR SELECT TO authenticated USING (public.wassell_can_view_workflows((SELECT auth.uid())));
CREATE POLICY "workflow_groups_insert" ON public.workflow_groups FOR INSERT TO authenticated WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "workflow_groups_update" ON public.workflow_groups FOR UPDATE TO authenticated USING (public.wassell_is_admin((SELECT auth.uid()))) WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));
CREATE POLICY "workflow_groups_delete" ON public.workflow_groups FOR DELETE TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())));

-- workflow_runs: read gated by can-view; insert/modify/delete unchanged.
DROP POLICY IF EXISTS "workflow_runs_read" ON public.workflow_runs;
CREATE POLICY "workflow_runs_read" ON public.workflow_runs FOR SELECT TO authenticated USING (public.wassell_can_view_workflows((SELECT auth.uid())));

COMMIT;
