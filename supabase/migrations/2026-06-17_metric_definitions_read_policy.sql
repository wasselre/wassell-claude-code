-- Acceptance pass (AP2): metric_definitions was admin-only for ALL commands, so a
-- metric-driven widget could not resolve its metric for any non-admin who can see
-- the dashboard (an unknown_metric warning + empty value). A metric DEFINITION is
-- not sensitive — its VALUE is still computed against the viewer's RLS-scoped
-- records — so reads open to all authenticated users while writes stay admin-only.
-- Mirrors model_views (shared definitions readable, owner/admin writable). Public
-- dashboards are unaffected: anon reads stored snapshots, never this table.
--
-- Applied to wassell-prod 2026-06-17 via the Supabase MCP. Idempotent.

ALTER TABLE public.metric_definitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS metric_definitions_admin ON public.metric_definitions;
DROP POLICY IF EXISTS metric_definitions_read ON public.metric_definitions;
DROP POLICY IF EXISTS metric_definitions_write ON public.metric_definitions;

-- Any authenticated user may READ metric definitions (so metric-driven widgets
-- resolve for everyone who can see a dashboard).
CREATE POLICY metric_definitions_read ON public.metric_definitions
  FOR SELECT TO authenticated
  USING (true);

-- Only admins may CREATE / EDIT / DELETE metrics.
CREATE POLICY metric_definitions_write ON public.metric_definitions
  FOR ALL TO authenticated
  USING (wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (wassell_is_admin((SELECT auth.uid())));
