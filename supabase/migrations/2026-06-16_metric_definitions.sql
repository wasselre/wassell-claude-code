-- Semantic Metrics layer (Phase A analytics platform). A metric is a named,
-- reusable measure (Revenue, Response Rate, …) stored as a value-only
-- AnalyticsQuery. KPI targets are intentionally NOT here — a future
-- KPIDefinition { metric_id, target_value, … } layers on top without changing
-- this table or the engine.
--
-- Mirrors the dashboards table: JSONB definition, admin-only RLS via
-- wassell_is_admin, an updated_at trigger. Frontend store slice is
-- `metricDefinitions` (load + saveMetricDefinition / deleteMetricDefinition),
-- and the engine resolves AggregationConfig.metric_id from ctx.metrics.
--
-- Applied to wassell-prod 2026-06-16 via the Supabase MCP; recorded here so
-- branches / restores / fresh installs get it. Idempotent.

CREATE TABLE IF NOT EXISTS public.metric_definitions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  label_ar      TEXT NOT NULL,
  label_en      TEXT NOT NULL,
  description   TEXT,
  query         JSONB NOT NULL DEFAULT '{}'::jsonb,
  formula       TEXT,
  inputs        JSONB,
  format        JSONB,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  owner_user_id UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.metric_definitions ENABLE ROW LEVEL SECURITY;

-- Admin-only, same posture as dashboards/workflows. Non-admins get an empty
-- set (not an error), so initialize()'s supabaseLoad is a no-op for them.
DROP POLICY IF EXISTS metric_definitions_admin ON public.metric_definitions;
CREATE POLICY metric_definitions_admin ON public.metric_definitions
  FOR ALL
  USING (wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (wassell_is_admin((SELECT auth.uid())));

DROP TRIGGER IF EXISTS set_updated_at_metric_definitions ON public.metric_definitions;
CREATE TRIGGER set_updated_at_metric_definitions
  BEFORE UPDATE ON public.metric_definitions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
