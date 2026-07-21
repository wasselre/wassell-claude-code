-- ============================================================================
-- WhatsApp activity bridge (2026-07-21)
--
-- The missing OUTBOUND half of the WhatsApp↔followups wire, plus the inbound
-- mirror. Design agreed with the user (sales-process improvement plan):
--
--  * ANY outbound message on a client-linked chat arms that client's WhatsApp
--    follow-up as "waiting for customer" (message_sent_waiting_response),
--    creating one if none exists, and retires stale REACH-OUT tasks
--    (appointment_booking_call / no_show_recovery_call) — the rep never
--    "sends through the task" again.
--  * An inbound message for a linked client with NO open follow-up at all
--    creates a "your turn" WhatsApp task (whatsapp_state='replied', due now)
--    so no conversation can need a human while the queue shows nothing.
--  * 24h silence nudge + day-5 call escalation are NOT reimplemented here —
--    the existing on_due sweeper + "WhatsApp No-Response Escalation" workflow
--    already handle tasks in message_sent_waiting_response with a
--    scheduled_datetime deadline. These functions just arm that machinery.
--
-- Called by api/_lib/chatIngest.ts (WAHA webhook) — the same posture as
-- mark_whatsapp_replied (v2/v3), which reconcile_inbound_whatsapp wraps.
-- Both functions are idempotent: webhook retries / duplicate deliveries
-- re-stamp the same state, never duplicate tasks.
-- ============================================================================

-- ─── Outbound: rep sent a message → ball is with the customer ───────────────
CREATE OR REPLACE FUNCTION public.reconcile_outbound_whatsapp(
  p_client_id  uuid,
  p_message_at timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_model_id  uuid;
  v_msg_at    timestamptz := COALESCE(p_message_at, now());
  v_stage     text;
  v_rep       text;
  v_wa_id     uuid;
  v_first     text;
  v_attempt   int;
  v_cancelled int := 0;
  v_deadline  text;
  v_now_iso   text;
BEGIN
  IF p_client_id IS NULL THEN RETURN 0; END IF;

  SELECT id INTO v_model_id FROM public.models WHERE name = 'followups' LIMIT 1;
  IF v_model_id IS NULL THEN RETURN 0; END IF;

  -- Terminal clients are never chased (mirrors the supersede layer's stance).
  SELECT data->>'client_stage', data->>'client_owner'
    INTO v_stage, v_rep
  FROM public.records WHERE id = p_client_id;
  IF v_stage IN ('خاسر', 'مغلق ناجح', 'غير مؤهل') THEN RETURN 0; END IF;

  v_deadline := to_char((v_msg_at + interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_now_iso  := to_char(v_msg_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  -- 1. Existing open WhatsApp task → (re)arm the waiting state.
  --    Also covers 'replied' → rep answered → back to waiting on customer.
  SELECT r.id,
         NULLIF(r.data->>'first_whatsapp_sent_at', ''),
         COALESCE(NULLIF(r.data->>'whatsapp_attempt_number', '')::int, 1)
    INTO v_wa_id, v_first, v_attempt
  FROM public.records r
  WHERE r.model_id = v_model_id
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    AND ( (jsonb_typeof(r.data->'followup_type') = 'array'  AND r.data->'followup_type' ? 'whatsapp_follow_up')
       OR (jsonb_typeof(r.data->'followup_type') = 'string' AND r.data->>'followup_type' = 'whatsapp_follow_up') )
    AND r.data->>'client_id' = p_client_id::text
  ORDER BY r.created_at DESC
  LIMIT 1;

  IF v_wa_id IS NOT NULL THEN
    -- fired_at is REMOVED (not nulled) so the on_due sweep re-claims at the
    -- new deadline; client_messaged_at cleared — the rep has now answered it.
    UPDATE public.records
    SET data = (data - 'fired_at' - 'client_messaged_at')
      || jsonb_build_object(
           'whatsapp_state',          'message_sent_waiting_response',
           'followup_status',         'in_progress',
           'sent_at',                 v_now_iso,
           'first_whatsapp_sent_at',  COALESCE(v_first, v_now_iso),
           'whatsapp_attempt_number', v_attempt,
           'scheduled_datetime',      v_deadline,
           'source_followup_id',      v_wa_id::text)
    WHERE id = v_wa_id;
  ELSE
    -- 2. No open WhatsApp task → create one, already waiting.
    v_wa_id := gen_random_uuid();
    INSERT INTO public.records (id, model_id, data, created_by_user_id)
    VALUES (v_wa_id, v_model_id,
      jsonb_build_object(
        'client_id',               p_client_id::text,
        'sales_rep',               v_rep,
        'followup_type',           jsonb_build_array('whatsapp_follow_up'),
        'followup_status',         'in_progress',
        'whatsapp_state',          'message_sent_waiting_response',
        'sent_at',                 v_now_iso,
        'first_whatsapp_sent_at',  v_now_iso,
        'whatsapp_attempt_number', 1,
        'followup_number',         1,
        'scheduled_datetime',      v_deadline,
        'source_followup_id',      v_wa_id::text,
        'creation_source',         'outbound_whatsapp'),
      NULL);
  END IF;

  -- 3. Retire stale REACH-OUT tasks — the rep just reached out on WhatsApp.
  --    Deliberately ONLY these two types (user decision): offer / after-visit /
  --    financing follow-ups represent commitments needing a real outcome.
  UPDATE public.records r
  SET data = (r.data - 'whatsapp_state')
    || jsonb_build_object(
         'followup_status',     'cancelled',
         'cancel_reason',       'contacted_via_whatsapp',
         'cancelled_at',        v_now_iso,
         'cancelled_by_system', true)
  WHERE r.model_id = v_model_id
    AND r.id <> v_wa_id
    AND r.data->>'client_id' = p_client_id::text
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    AND ( (jsonb_typeof(r.data->'followup_type') = 'array'
             AND r.data->'followup_type' ?| ARRAY['appointment_booking_call','no_show_recovery_call'])
       OR (jsonb_typeof(r.data->'followup_type') = 'string'
             AND r.data->>'followup_type' = ANY(ARRAY['appointment_booking_call','no_show_recovery_call'])) );
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  RETURN v_cancelled + 1;
END;
$$;

-- ─── Inbound: customer messaged → reply-reconcile + guarantee a task ────────
CREATE OR REPLACE FUNCTION public.reconcile_inbound_whatsapp(
  p_client_id  uuid,
  p_message_at timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_model_id uuid;
  v_msg_at   timestamptz := COALESCE(p_message_at, now());
  v_stage    text;
  v_rep      text;
  v_replied  int := 0;
  v_has_open boolean;
  v_now_iso  text;
BEGIN
  IF p_client_id IS NULL THEN RETURN 0; END IF;

  -- v2/v3 semantics unchanged: waiting→replied + early-message stamp.
  v_replied := public.mark_whatsapp_replied(p_client_id, v_msg_at);

  SELECT id INTO v_model_id FROM public.models WHERE name = 'followups' LIMIT 1;
  IF v_model_id IS NULL THEN RETURN v_replied; END IF;

  SELECT data->>'client_stage', data->>'client_owner'
    INTO v_stage, v_rep
  FROM public.records WHERE id = p_client_id;
  IF v_stage IN ('خاسر', 'مغلق ناجح', 'غير مؤهل') THEN RETURN v_replied; END IF;

  -- Invariant: a linked, live client who messages us must have an open task.
  -- Only when NO open follow-up of ANY type exists do we create the
  -- "your turn" WhatsApp task (due now, replied state → surfaces on top).
  SELECT EXISTS (
    SELECT 1 FROM public.records r
    WHERE r.model_id = v_model_id
      AND r.data->>'client_id' = p_client_id::text
      AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
  ) INTO v_has_open;

  IF NOT v_has_open THEN
    v_now_iso := to_char(v_msg_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
    INSERT INTO public.records (id, model_id, data, created_by_user_id)
    VALUES (gen_random_uuid(), v_model_id,
      jsonb_build_object(
        'client_id',               p_client_id::text,
        'sales_rep',               v_rep,
        'followup_type',           jsonb_build_array('whatsapp_follow_up'),
        'followup_status',         'open',
        'whatsapp_state',          'replied',
        'client_messaged_at',      v_now_iso,
        'whatsapp_attempt_number', 1,
        'followup_number',         1,
        'scheduled_datetime',      v_now_iso,
        'creation_source',         'inbound_whatsapp'),
      NULL);
    v_replied := v_replied + 1;
  END IF;

  RETURN v_replied;
END;
$$;

-- ─── One-time backfill ──────────────────────────────────────────────────────
-- Snapshot every open/in_progress follow-up first (restore path), then apply
-- the outbound logic once for clients whose chat's LAST message is outbound
-- within the past 7 days — so the queue is honest on day one. Older silent
-- threads are left alone (they'd instantly nudge and flood the actions tab).
CREATE TABLE IF NOT EXISTS public._backup_followups_wa_bridge_20260721 AS
SELECT r.* FROM public.records r
WHERE r.model_id = (SELECT id FROM public.models WHERE name = 'followups' LIMIT 1)
  AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress');

DO $$
DECLARE
  v_chats_model uuid;
  v_row record;
  v_n int := 0;
BEGIN
  SELECT id INTO v_chats_model FROM public.models WHERE name = 'chats' LIMIT 1;
  IF v_chats_model IS NULL THEN RETURN; END IF;

  FOR v_row IN
    SELECT DISTINCT ON (c.data->>'client_link')
           (c.data->>'client_link')::uuid AS client_id,
           public.try_timestamptz(c.data->>'last_message_at') AS last_at
    FROM public.records c
    WHERE c.model_id = v_chats_model
      AND c.data->>'last_message_flow' = 'out'
      AND c.data->>'client_link' ~* '^[0-9a-f-]{36}$'
      AND public.try_timestamptz(c.data->>'last_message_at') > now() - interval '7 days'
    ORDER BY c.data->>'client_link', public.try_timestamptz(c.data->>'last_message_at') DESC
  LOOP
    PERFORM public.reconcile_outbound_whatsapp(v_row.client_id, v_row.last_at);
    v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE 'wa-bridge backfill: reconciled % clients', v_n;
END;
$$;
