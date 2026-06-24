-- ============================================================================
-- 2026-06-23: workflow_capture_models enrollment gate (Phase 1)
-- ----------------------------------------------------------------------------
-- HARD GATE: a model cannot be enrolled for server-authoritative workflows
-- while ANY active workflow triggered on it (create/update/delete — the events
-- the capture trigger enqueues) contains an action the runner v1 cannot
-- faithfully execute. Otherwise that workflow's runs would fail server-side
-- (by design — no partial execution), so enrollment must wait until the action
-- is supported or the workflow is handled deliberately.
--
-- on_due is intentionally excluded: those workflows run on the existing sweeper,
-- not this capture pipeline, so enrollment doesn't change their behavior.
--
-- Known current blocker: followups workflow "Confirmation Completed"
-- (12da04dd-8119-4aeb-a573-ce85864ab657) has a send_whatsapp_message action,
-- which is unsupported_in_runner_v1 — so enrolling `followups` is rejected
-- until that's resolved.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.tg_workflow_capture_models_gate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_bad  int;
  v_list text;
BEGIN
  SELECT count(*), string_agg(DISTINCT s.workflow_name || ' (' || s.workflow_id || ' / ' || s.action_type || ')', ', ')
    INTO v_bad, v_list
    FROM public.workflow_runner_action_support s
   WHERE s.model_id = NEW.model_id
     AND s.is_active
     AND s.trigger_event IN ('create', 'update', 'delete')
     AND s.runner_support_status = 'unsupported_in_runner_v1';

  IF COALESCE(v_bad, 0) > 0 THEN
    RAISE EXCEPTION
      'Cannot enroll model % for server-authoritative workflows: % unsupported runner action(s) in active create/update/delete workflows: %. Add runner support or handle those workflows before enrolling.',
      NEW.model_id, v_bad, v_list
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS workflow_capture_models_gate ON public.workflow_capture_models;
CREATE TRIGGER workflow_capture_models_gate
  BEFORE INSERT OR UPDATE ON public.workflow_capture_models
  FOR EACH ROW EXECUTE FUNCTION public.tg_workflow_capture_models_gate();

COMMIT;

-- ── DOWN ────────────────────────────────────────────────────────────────
-- DROP TRIGGER IF EXISTS workflow_capture_models_gate ON public.workflow_capture_models;
-- DROP FUNCTION IF EXISTS public.tg_workflow_capture_models_gate();
