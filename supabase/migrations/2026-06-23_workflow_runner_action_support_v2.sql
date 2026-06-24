-- ============================================================================
-- 2026-06-23 (v2): workflow_runner_action_support — add send_whatsapp_message
-- ----------------------------------------------------------------------------
-- The runner now supports send_whatsapp_message (via the shared
-- haberchat.sendMessage path), so it joins create_record / update_record in the
-- supported set. This makes the enrollment gate pass for models whose only
-- previously-unsupported action was a WhatsApp send (e.g. followups' workflow
-- "Confirmation Completed").
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
  CASE WHEN action_type IN ('create_record', 'update_record', 'send_whatsapp_message')
       THEN 'supported' ELSE 'unsupported_in_runner_v1' END AS runner_support_status
FROM acts;
