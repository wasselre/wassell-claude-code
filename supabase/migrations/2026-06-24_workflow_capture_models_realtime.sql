-- ============================================================================
-- 2026-06-24: realtime for workflow_capture_models (client-skip propagation)
-- ----------------------------------------------------------------------------
-- The browser client engine must SKIP firing workflows for models the Fly
-- worker owns (workflow_capture_models) — otherwise client + server both fire
-- and every create/update double-executes. The SPA loads the allowlist at init
-- and subscribes to this table over Realtime so enroll/unenroll propagates
-- without a hard refresh (closing the double-fire window fast).
--
-- Additive + safe: only puts the table on the supabase_realtime publication and
-- sets REPLICA IDENTITY FULL (so DELETE payloads carry the model_id the SPA
-- needs). No data change, no worker change. Idempotent.
-- ============================================================================

ALTER TABLE public.workflow_capture_models REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'workflow_capture_models'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.workflow_capture_models;
  END IF;
END $$;

-- ── DOWN ────────────────────────────────────────────────────────────────
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.workflow_capture_models;
