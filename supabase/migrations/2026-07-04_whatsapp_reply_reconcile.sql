-- Phase A — WhatsApp reply reconciliation.
--
-- When a customer sends an inbound WhatsApp message, the Haberchat webhook
-- calls this RPC with the linked client's id. It marks that client's ACTIVE
-- WhatsApp follow-up task(s) as `whatsapp_state = 'replied'` so:
--   1. the task surfaces immediately in the Sales Queue / My Tasks
--      (even if its scheduled_datetime is still in the future), and
--   2. the on_due "WhatsApp No-Response Escalation" workflow stops matching it
--      (that workflow requires whatsapp_state = 'message_sent_waiting_response'),
--      so a client who answered is never treated as silent.
--
-- SECURITY DEFINER: the webhook runs as service role already, but keeping this
-- DEFINER + a fixed search_path makes it safe to call from any authenticated
-- context in future without leaking RLS. Only touches followups rows.
--
-- Storage shapes (verified on prod 2026-07-04, all 1,339 rows consistent):
--   - records.data->>'client_id'      is a SCALAR string (the client uuid)
--   - records.data->'followup_type'   is a JSONB ARRAY  (e.g. ["whatsapp_follow_up"])
--
-- The UPDATE fires the existing BEFORE version-bump trigger and the AFTER
-- "touch client on activity" trigger (which recomputes the client's next-action
-- derived fields), so the rep's queue updates live via Realtime — no extra work.

CREATE OR REPLACE FUNCTION public.mark_whatsapp_replied(p_client_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_model_id uuid;
  v_count    integer;
BEGIN
  IF p_client_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT id INTO v_model_id FROM public.models WHERE name = 'followups' LIMIT 1;
  IF v_model_id IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.records r
  SET data = jsonb_set(r.data, '{whatsapp_state}', '"replied"'::jsonb, true)
  WHERE r.model_id = v_model_id
    -- active only: open or in_progress (null/'' legacy status → treated as open)
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    -- WhatsApp follow-up type (followup_type is a JSONB array)
    AND jsonb_typeof(r.data->'followup_type') = 'array'
    AND r.data->'followup_type' ? 'whatsapp_follow_up'
    -- linked to this client (client_id is a scalar string)
    AND r.data->>'client_id' = p_client_id::text
    -- idempotent: skip rows already marked replied (no needless version bump)
    AND COALESCE(r.data->>'whatsapp_state', '') IS DISTINCT FROM 'replied';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.mark_whatsapp_replied(uuid) IS
  'Phase A: mark a client''s active WhatsApp follow-up(s) as replied on inbound message. Called by the Haberchat webhook.';
