-- ============================================================================
-- 2026-06-23: workflow_runner_action_support — runner coverage audit (Phase 1)
-- ----------------------------------------------------------------------------
-- Read-only view. Lists EVERY action of EVERY workflow (branches + legacy flat,
-- deduped by action id) and classifies it against the runner's supported set.
-- Run this BEFORE enrolling any model in workflow_capture_models: if a workflow
-- that would be server-routed contains an unsupported action, the runner fails
-- the run loudly (no silent partial execution) — so enrollment must wait until
-- that action type is supported.
--
-- supported               = create_record, update_record (runner v1)
-- unsupported_in_runner_v1 = everything else (send_whatsapp_message,
--                            send_notification, assign_user, http_request,
--                            outbound_ivr, paseet_query)
--
-- security_invoker so the view respects the caller's RLS on `workflows`.
-- ============================================================================

CREATE OR REPLACE VIEW public.workflow_runner_action_support
WITH (security_invoker = true) AS
WITH acts AS (
  SELECT w.id AS workflow_id, COALESCE(w.label_en, w.label_ar) AS workflow_name,
         w.trigger_model_id AS model_id, w.trigger_event, w.is_active,
         a->>'id' AS action_id, a->>'type' AS action_type
  FROM public.workflows w,
       LATERAL jsonb_array_elements(COALESCE(w.branches, '[]'::jsonb)) br,
       LATERAL jsonb_array_elements(COALESCE(br->'actions', '[]'::jsonb)) a
  UNION
  SELECT w.id, COALESCE(w.label_en, w.label_ar), w.trigger_model_id, w.trigger_event, w.is_active,
         a->>'id', a->>'type'
  FROM public.workflows w,
       LATERAL jsonb_array_elements(COALESCE(w.actions, '[]'::jsonb)) a
)
SELECT DISTINCT
  workflow_id, workflow_name, model_id, trigger_event, is_active,
  action_id, action_type,
  CASE WHEN action_type IN ('create_record', 'update_record')
       THEN 'supported' ELSE 'unsupported_in_runner_v1' END AS runner_support_status
FROM acts;

-- ── DOWN ────────────────────────────────────────────────────────────────
-- DROP VIEW IF EXISTS public.workflow_runner_action_support;
