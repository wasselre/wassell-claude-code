-- Marketing OS · new capability `delete_records`
--
-- Adds a DEDICATED capability that gates the hard-deletion of every marketing
-- record — content, scenes, campaigns, executions (ad sets), ads, assets and
-- manual tasks. Until now deletion piggy-backed on the SAME capability as
-- editing (deleting a content item only needed `write_content`; an asset only
-- `manage_assets`; an ad only `enter_metrics`). Splitting delete into its own
-- gate lets an admin grant "can edit" without granting "can destroy".
--
-- Capabilities are DATA (`role_capabilities`) — see CLAUDE.md "Marketing OS
-- capabilities are DATA". This is the seed + the RLS re-gating. The api
-- CAPABILITIES list and the client Capability type are updated in the same PR.
--
-- Seed policy (user decision 2026-08-16): grant ONLY to marketing_manager.
-- App admins already delete via the wassell_is_admin bypass inside
-- wassell_mos_can, so they need no row here. Every other role loses delete
-- until an admin turns it on in Settings → Roles and permissions.
--
-- NOT backward-compatible with the currently-deployed frontend in the sense
-- that it TIGHTENS behaviour: a non-manager who could delete before now gets a
-- 403 (surfaced as an error toast) until the matching frontend — which hides
-- the delete buttons for roles lacking the capability — ships. That tightening
-- IS the feature; deletes for marketing_manager + admins are unaffected.

BEGIN;

-- 1. Seed the grant — marketing_manager only. -----------------------------
INSERT INTO public.role_capabilities (role_id, capability)
SELECT r.id, 'delete_records'
FROM public.roles r
WHERE r.key = 'mos_marketing_manager'
ON CONFLICT (role_id, capability) DO NOTHING;

-- 2. Re-gate DELETE on the per-command tables (mos_core loop). -------------
-- These have discrete _read/_ins/_upd/_del policies; only _del changes.
DROP POLICY IF EXISTS mos_content_del ON public.mos_content;
CREATE POLICY mos_content_del ON public.mos_content FOR DELETE TO authenticated
  USING (public.wassell_mos_can('delete_records'));

DROP POLICY IF EXISTS mos_scenes_del ON public.mos_scenes;
CREATE POLICY mos_scenes_del ON public.mos_scenes FOR DELETE TO authenticated
  USING (public.wassell_mos_can('delete_records'));

-- Manual tasks keep the "creator may delete their own" affordance; only the
-- capability half of the OR changes (was `assign_task`).
DROP POLICY IF EXISTS mos_manual_tasks_del ON public.mos_manual_tasks;
CREATE POLICY mos_manual_tasks_del ON public.mos_manual_tasks FOR DELETE TO authenticated
  USING (
    public.wassell_mos_can('delete_records')
    OR created_by_user_id = public.wassell_app_user_id(auth.uid())
  );

-- 3. Re-gate the tables that used a single FOR ALL write policy. -----------
-- Splitting the ALL policy into INSERT + UPDATE (unchanged cap) plus a new
-- DELETE policy (delete_records) is the ONLY way to peel delete off: with
-- permissive policies a leftover ALL policy would still OR-allow delete. SELECT
-- keeps its own separate `_read` policy, so reads are unaffected.

-- Assets: write was `manage_assets` (+ file-access WITH CHECK). ------------
DROP POLICY IF EXISTS mos_assets_write ON public.mos_assets;
CREATE POLICY mos_assets_ins ON public.mos_assets FOR INSERT TO authenticated
  WITH CHECK (
    public.wassell_mos_can('manage_assets')
    AND (file_id IS NULL OR public.wassell_can_access_file(file_id, 'view'))
  );
CREATE POLICY mos_assets_upd ON public.mos_assets FOR UPDATE TO authenticated
  USING (public.wassell_mos_can('manage_assets'))
  WITH CHECK (
    public.wassell_mos_can('manage_assets')
    AND (file_id IS NULL OR public.wassell_can_access_file(file_id, 'view'))
  );
CREATE POLICY mos_assets_del ON public.mos_assets FOR DELETE TO authenticated
  USING (public.wassell_mos_can('delete_records'));

-- Campaigns: write was `approve_budget`. ----------------------------------
DROP POLICY IF EXISTS mos_campaigns_write ON public.mos_campaigns;
CREATE POLICY mos_campaigns_ins ON public.mos_campaigns FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mos_can('approve_budget'));
CREATE POLICY mos_campaigns_upd ON public.mos_campaigns FOR UPDATE TO authenticated
  USING (public.wassell_mos_can('approve_budget'))
  WITH CHECK (public.wassell_mos_can('approve_budget'));
CREATE POLICY mos_campaigns_del ON public.mos_campaigns FOR DELETE TO authenticated
  USING (public.wassell_mos_can('delete_records'));

-- Executions (ad sets): write was `enter_metrics`. ------------------------
DROP POLICY IF EXISTS mos_campaign_executions_write ON public.mos_campaign_executions;
CREATE POLICY mos_campaign_executions_ins ON public.mos_campaign_executions FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mos_can('enter_metrics'));
CREATE POLICY mos_campaign_executions_upd ON public.mos_campaign_executions FOR UPDATE TO authenticated
  USING (public.wassell_mos_can('enter_metrics'))
  WITH CHECK (public.wassell_mos_can('enter_metrics'));
CREATE POLICY mos_campaign_executions_del ON public.mos_campaign_executions FOR DELETE TO authenticated
  USING (public.wassell_mos_can('delete_records'));

-- Execution ads: write was `enter_metrics`. -------------------------------
DROP POLICY IF EXISTS mos_execution_ads_write ON public.mos_execution_ads;
CREATE POLICY mos_execution_ads_ins ON public.mos_execution_ads FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mos_can('enter_metrics'));
CREATE POLICY mos_execution_ads_upd ON public.mos_execution_ads FOR UPDATE TO authenticated
  USING (public.wassell_mos_can('enter_metrics'))
  WITH CHECK (public.wassell_mos_can('enter_metrics'));
CREATE POLICY mos_execution_ads_del ON public.mos_execution_ads FOR DELETE TO authenticated
  USING (public.wassell_mos_can('delete_records'));

COMMIT;
