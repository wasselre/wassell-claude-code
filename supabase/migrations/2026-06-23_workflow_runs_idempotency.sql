-- ============================================================================
-- 2026-06-23: workflow_runs idempotency support for the server runner (Phase 1)
-- ----------------------------------------------------------------------------
-- Additive — no behavior change. Backs the idempotency-before-actions flow of
-- /api/internal/run-workflow-job. The guiding principle: idempotency must
-- protect BUSINESS EFFECTS (no duplicate follow-up), not just run rows.
--
-- workflow_runs.idempotency_key — the per-workflow TRANSITION key:
--     md5( workflow_id | workflow_config_hash | model_id | record_id
--        | trigger_event | sorted(changed_fields)
--        | prev values of workflow_dependency_fields
--        | new  values of workflow_dependency_fields )
--   where workflow_dependency_fields = EVERY field the workflow reads (trigger
--   filters, conditions, branch conditions, only_on_change, formula tokens,
--   action source mappings, role_variable conditions, skip_if_exists / create
--   dedup inputs) — NOT just condition fields, so an action-driving field that
--   changes between two otherwise-identical condition transitions does not get
--   falsely skipped. workflow_config_hash makes an intentional workflow edit
--   re-run a previously-completed transition under a NEW key (no false replay
--   block) while a true re-delivery of the same event+config collapses.
-- workflow_runs.workflow_config_hash — stored for debugging / drift detection.
-- workflow_runs.workflow_job_id      — link back to the driving job.
--
-- Failed-run discipline (enforced in the runner, not here): completed/skipped
-- ⇒ skip; processing|failed with the SAME workflow_job_id ⇒ reuse run_id;
-- failed from ANOTHER job ⇒ NOT casually revived. Same-job reuse keeps
-- workflow_run_id stable so the action-emission (run_id, action_id) key holds.
--
-- workflow_action_emissions — action-level create dedup with TWO guards:
--   * (workflow_run_id, action_id) — retry of the SAME (reused) run reuses the
--     already-created record.
--   * (workflow_id, action_id, source_record_id, target_model_id, business_key)
--     WHERE business_key IS NOT NULL — CROSS-RUN dedup: even if a transition-key
--     bug, a manual replay, or a race spawns a second run, the create still
--     can't duplicate. business_key is WORKFLOW-DEFINED (from the action's
--     skip_if_exists / dedup config), never hardcoded — the engine doesn't know
--     what a "followup" is.
-- ============================================================================

BEGIN;

ALTER TABLE public.workflow_runs ADD COLUMN IF NOT EXISTS idempotency_key     text;
ALTER TABLE public.workflow_runs ADD COLUMN IF NOT EXISTS workflow_config_hash text;
ALTER TABLE public.workflow_runs ADD COLUMN IF NOT EXISTS workflow_job_id     uuid;

CREATE INDEX IF NOT EXISTS workflow_runs_idempotency_idx
  ON public.workflow_runs (workflow_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.workflow_action_emissions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id   uuid        NOT NULL,
  workflow_id       uuid        NOT NULL,
  workflow_job_id   uuid,
  action_id         text        NOT NULL,
  source_record_id  uuid,
  target_model_id   uuid,
  business_key      text,
  created_record_id uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Same-run retry dedup.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_action_emissions_run_action_uniq
  ON public.workflow_action_emissions (workflow_run_id, action_id);

-- Cross-run business-effect dedup (the real duplicate-follow-up guard). NULLs
-- compare distinct in a unique index, so this only bites when business_key —
-- and the scoping ids — are all present, which is exactly the create case.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_action_emissions_business_uniq
  ON public.workflow_action_emissions (workflow_id, action_id, source_record_id, target_model_id, business_key)
  WHERE business_key IS NOT NULL;

ALTER TABLE public.workflow_action_emissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "workflow_action_emissions_admin_select" ON public.workflow_action_emissions;
CREATE POLICY "workflow_action_emissions_admin_select"
  ON public.workflow_action_emissions FOR SELECT TO authenticated
  USING (public.wassell_is_admin(auth.uid()));

COMMIT;
