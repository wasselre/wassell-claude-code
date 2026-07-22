-- Records for the orphaned ad-creative storage cleanup (worker/src/marketing/
-- creativeCleanup.ts). Every run — dry-run or real — writes a row here so the
-- cleanup is observable and auditable. Dry-run is the production default.
CREATE TABLE IF NOT EXISTS public.mkt_storage_cleanup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,                 -- 'ad_creatives'
  dry_run boolean NOT NULL DEFAULT true,
  scanned int NOT NULL DEFAULT 0,
  orphans int NOT NULL DEFAULT 0,
  deleted int NOT NULL DEFAULT 0,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_storage_cleanup_runs_idx ON public.mkt_storage_cleanup_runs (kind, created_at DESC);
ALTER TABLE public.mkt_storage_cleanup_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_storage_cleanup_runs_read ON public.mkt_storage_cleanup_runs;
CREATE POLICY mkt_storage_cleanup_runs_read ON public.mkt_storage_cleanup_runs FOR SELECT TO authenticated USING (true);
