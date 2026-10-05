-- ============================================================================
-- A client with an open search request is still followed up, and what the
-- follow-up learns updates THAT request (operator, 2026-10-05):
--   "There is no contradiction between doing follow-ups with the client and
--    having open requests. The follow-ups should result in updating the
--    request details."
--
-- 1. «طلب غير مجاب» no longer stops the AI from reading the chat for a result
--    (chat_outcome_suggestion_enqueue), drafting follow-ups
--    (ai_followup_candidates) or keeping WhatsApp tasks in step with rep
--    messages (reconcile_outbound_whatsapp). The other closed stages still do.
--    Each function is re-emitted VERBATIM from the live definition with only
--    that stage list changed.
-- 2. ONE open request per client. The «Create Unresponded Requests» workflow
--    makes a new request on every «طلب غير مجاب» result; when the client
--    already has an open one (any status except fulfilled / client_dropped),
--    the BEFORE INSERT trigger below adds the new notes to it — dated — and
--    skips the duplicate. The request's criteria are the client's saved
--    preferences (see requestReadiness.ts), which the AI already updates from
--    the chat, so the notes are the only part that needs merging.
--    A closed request does not block a new one.
--    The trigger never fails a save: on any error it lets the insert through.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.ai_followup_candidates(p_limit integer DEFAULT 10, p_campaign boolean DEFAULT NULL::boolean)
 RETURNS TABLE(followup_id uuid, client_id uuid, chat_wid text, chat_record_id uuid, attempt integer, due_at timestamp with time zone, campaign text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH m AS (
    SELECT (SELECT id FROM public.models WHERE name = 'followups' LIMIT 1) AS followups,
           (SELECT id FROM public.models WHERE name = 'chats' LIMIT 1)     AS chats
  ), f AS (
    SELECT r.id,
           (r.data->>'client_id')::uuid AS client_id,
           COALESCE(NULLIF(r.data->>'whatsapp_attempt_number', '')::int, 1) AS attempt,
           public.try_timestamptz(r.data->>'scheduled_datetime') AS due,
           NULLIF(r.data->>'campaign_message', '') AS campaign
      FROM public.records r, m
     WHERE r.model_id = m.followups
       AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') = 'open'
       AND COALESCE(r.data->>'whatsapp_state', '') = ''
       AND COALESCE(r.data->>'sent_at', '') = ''
       AND ( (jsonb_typeof(r.data->'followup_type') = 'array'  AND r.data->'followup_type' ? 'whatsapp_follow_up')
          OR (jsonb_typeof(r.data->'followup_type') = 'string' AND r.data->>'followup_type' = 'whatsapp_follow_up') )
       AND r.data->>'client_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND public.try_timestamptz(r.data->>'scheduled_datetime') <= now()
       AND (p_campaign IS NULL
            OR (p_campaign AND COALESCE(r.data->>'campaign_message', '') <> '')
            OR (NOT p_campaign AND COALESCE(r.data->>'campaign_message', '') = ''))
  )
  SELECT f.id, f.client_id, ch.wid, ch.id, f.attempt, f.due, f.campaign
    FROM f
    CROSS JOIN m
    JOIN public.records cl ON cl.id = f.client_id
    JOIN LATERAL (
      SELECT c.id, c.data->>'wid' AS wid, c.data AS cdata
        FROM public.records c
       WHERE c.model_id = m.chats AND c.data->>'client_link' = f.client_id::text AND COALESCE(c.data->>'wid', '') <> ''
       ORDER BY c.updated_at DESC
       LIMIT 1
    ) ch ON true
   WHERE COALESCE(cl.data->>'client_stage', '') NOT IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار')
     AND COALESCE(ch.cdata->>'ai_paused', 'false') <> 'true'
     AND NOT EXISTS (SELECT 1 FROM public.ai_actions a
                      WHERE a.kind = 'followup_message' AND a.followup_id = f.id AND a.round_key = f.attempt::text)
     AND EXISTS (SELECT 1 FROM public.chat_messages mi WHERE mi.chat_wid = ch.wid AND mi.flow = 'in')
     AND (f.campaign IS NOT NULL OR
          (SELECT ml.flow FROM public.chat_messages ml
            WHERE ml.chat_wid = ch.wid AND ml.kind NOT IN ('reaction', 'call_log', 'e2e_notification', 'notification', 'notification_template', 'revoked')
            ORDER BY ml.date DESC LIMIT 1) IS DISTINCT FROM 'in')
     AND NOT EXISTS (SELECT 1 FROM public.chat_messages mr WHERE mr.chat_wid = ch.wid AND mr.date > now() - interval '2 hours')
     AND (f.campaign IS NOT NULL OR NOT EXISTS (
       SELECT 1 FROM public.records t
        WHERE t.model_id = m.followups
          AND t.data->>'client_id' = f.client_id::text
          AND COALESCE(NULLIF(t.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
          AND ( t.data->'followup_type' ?| ARRAY['appointment_booking_call', 'no_show_recovery_call']
             OR t.data->>'followup_type' IN ('appointment_booking_call', 'no_show_recovery_call') )))
     -- A campaign lead whose day has not come yet gets NO ordinary follow-up:
     -- their campaign message is their next message (operator, 2026-10-05).
     AND (f.campaign IS NOT NULL OR NOT EXISTS (
       SELECT 1 FROM public.sales_campaign_leads l
        WHERE l.client_id = f.client_id AND l.status = 'planned'))
   ORDER BY (f.campaign IS NOT NULL) DESC, f.due ASC
   LIMIT GREATEST(1, LEAST(p_limit, 50));
$function$;

CREATE OR REPLACE FUNCTION public.chat_outcome_suggestion_enqueue(p_client uuid, p_chat_record uuid, p_chat_wid text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_stage text;
  v_owner text;
  v_rep   uuid;
  v_id    uuid;
BEGIN
  IF p_client IS NULL THEN RETURN NULL; END IF;
  SELECT data->>'client_stage',
         CASE jsonb_typeof(data->'client_owner')
           WHEN 'array' THEN data->'client_owner'->>0 ELSE data->>'client_owner' END
    INTO v_stage, v_owner
  FROM public.records WHERE id = p_client;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF v_stage IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار') THEN RETURN NULL; END IF;
  IF v_owner ~* '^[0-9a-f-]{36}$' THEN v_rep := v_owner::uuid; END IF;

  INSERT INTO public.chat_outcome_suggestions
    (client_id, chat_record_id, chat_wid, rep_user_id, not_before)
  VALUES (p_client, p_chat_record, p_chat_wid, v_rep, now() + interval '3 minutes')
  ON CONFLICT (client_id) WHERE status = 'queued' DO UPDATE
     SET not_before     = EXCLUDED.not_before,
         chat_record_id = COALESCE(EXCLUDED.chat_record_id, chat_outcome_suggestions.chat_record_id),
         chat_wid       = COALESCE(EXCLUDED.chat_wid, chat_outcome_suggestions.chat_wid)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_outbound_whatsapp(p_client_id uuid, p_message_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  SELECT data->>'client_stage', data->>'client_owner'
    INTO v_stage, v_rep
  FROM public.records WHERE id = p_client_id;
  v_rep := COALESCE(NULLIF(v_rep, ''), public.wassell_default_sales_rep()::text);  -- auto-assign default rep
  IF v_stage IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار') THEN RETURN 0; END IF;

  v_deadline := to_char((v_msg_at + interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_now_iso  := to_char(v_msg_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

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

  UPDATE public.records r
  SET data = (r.data - 'whatsapp_state')
    || jsonb_build_object(
         'followup_status',     'cancelled',
         'cancel_reason',       CASE
             WHEN (jsonb_typeof(r.data->'followup_type') = 'array' AND r.data->'followup_type' ? 'whatsapp_follow_up')
               OR r.data->>'followup_type' = 'whatsapp_follow_up'
             THEN 'superseded_by_newer_whatsapp_task'
             ELSE 'contacted_via_whatsapp' END,
         'cancelled_at',        v_now_iso,
         'cancelled_by_system', true)
  WHERE r.model_id = v_model_id
    AND r.id <> v_wa_id
    AND r.data->>'client_id' = p_client_id::text
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    AND ( (jsonb_typeof(r.data->'followup_type') = 'array'
             AND r.data->'followup_type' ?| ARRAY['appointment_booking_call','no_show_recovery_call','whatsapp_follow_up'])
       OR (jsonb_typeof(r.data->'followup_type') = 'string'
             AND r.data->>'followup_type' = ANY(ARRAY['appointment_booking_call','no_show_recovery_call','whatsapp_follow_up'])) );
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  RETURN v_cancelled + 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_outbound_whatsapp(p_client_id uuid, p_message_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_source text DEFAULT 'composer'::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_conversational boolean := COALESCE(p_source, 'composer') NOT IN ('bulk', 'document', 'media_batch');
  v_from_id   text;
  v_from_type text;
  v_from_appt text;
BEGIN
  IF p_client_id IS NULL THEN RETURN 0; END IF;
  -- «calls first» (2026-10-05) — a rep's message no longer cancels the
  -- client's open booking / no-show call: only a recorded call result closes
  -- a call. It still supersedes the client's older WhatsApp tasks.
  -- «bot» — the WhatsApp bot's replies (send_source 'ai') are not a rep
  -- talking to the client: they must not cancel the client's call tasks, and
  -- must not flip a «client replied» task back to «waiting for reply».
  IF COALESCE(p_source, '') = 'ai' THEN RETURN 0; END IF;

  SELECT id INTO v_model_id FROM public.models WHERE name = 'followups' LIMIT 1;
  IF v_model_id IS NULL THEN RETURN 0; END IF;

  SELECT data->>'client_stage', data->>'client_owner'
    INTO v_stage, v_rep
  FROM public.records WHERE id = p_client_id;
  v_rep := COALESCE(NULLIF(v_rep, ''), public.wassell_default_sales_rep()::text);  -- auto-assign default rep
  IF v_stage IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار') THEN RETURN 0; END IF;

  v_deadline := to_char((v_msg_at + interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_now_iso  := to_char(v_msg_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

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

  IF NOT v_conversational THEN
    RETURN 1;
  END IF;

  WITH cancelled AS (
    UPDATE public.records r
    SET data = (r.data - 'whatsapp_state')
      || jsonb_build_object(
           'followup_status',     'cancelled',
           'cancel_reason',       CASE
               WHEN (jsonb_typeof(r.data->'followup_type') = 'array' AND r.data->'followup_type' ? 'whatsapp_follow_up')
                 OR r.data->>'followup_type' = 'whatsapp_follow_up'
               THEN 'superseded_by_newer_whatsapp_task'
               ELSE 'contacted_via_whatsapp' END,
           'cancelled_at',        v_now_iso,
           'cancelled_by_system', true,
           'handed_to_followup_id', v_wa_id::text)                           -- «handover»
    WHERE r.model_id = v_model_id
      AND r.id <> v_wa_id
      AND r.data->>'client_id' = p_client_id::text
      AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
      AND ( (jsonb_typeof(r.data->'followup_type') = 'array'
               AND r.data->'followup_type' ?| ARRAY['whatsapp_follow_up'])
         OR (jsonb_typeof(r.data->'followup_type') = 'string'
               AND r.data->>'followup_type' = ANY(ARRAY['whatsapp_follow_up'])) )
    RETURNING r.id, r.created_at,
              COALESCE(r.data->'followup_type'->>0, r.data->>'followup_type') AS ftype,
              NULLIF(r.data->>'appointment_id', '') AS appt
  )
  SELECT count(*)::int,
         (array_agg(c.id::text ORDER BY c.created_at DESC) FILTER (WHERE c.ftype <> 'whatsapp_follow_up'))[1],
         (array_agg(c.ftype    ORDER BY c.created_at DESC) FILTER (WHERE c.ftype <> 'whatsapp_follow_up'))[1],
         (array_agg(c.appt     ORDER BY c.created_at DESC) FILTER (WHERE c.ftype <> 'whatsapp_follow_up' AND c.appt IS NOT NULL))[1]
    INTO v_cancelled, v_from_id, v_from_type, v_from_appt
  FROM cancelled c;

  -- «handover» — the WhatsApp task records which call task it took over.
  IF v_from_id IS NOT NULL THEN
    UPDATE public.records w
    SET data = w.data
      || jsonb_build_object('handed_over_from_id', v_from_id, 'handed_over_from_type', v_from_type)
      || CASE WHEN NULLIF(w.data->>'previous_followup_id', '') IS NULL
              THEN jsonb_build_object('previous_followup_id', v_from_id) ELSE '{}'::jsonb END
      || CASE WHEN v_from_appt IS NOT NULL AND NULLIF(w.data->>'appointment_id', '') IS NULL
              THEN jsonb_build_object('appointment_id', v_from_appt) ELSE '{}'::jsonb END
    WHERE w.id = v_wa_id;
  END IF;

  RETURN v_cancelled + 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_unanswered_request_merge_open()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_open  uuid;
  v_notes text;
  v_old   text;
BEGIN
  IF NEW.model_id IS DISTINCT FROM (SELECT id FROM public.models WHERE name = 'unanswered_requests' LIMIT 1) THEN
    RETURN NEW;
  END IF;
  BEGIN
    IF COALESCE(NEW.data->>'client_id', '') !~* '^[0-9a-f-]{36}$' THEN RETURN NEW; END IF;

    SELECT r.id, r.data->>'request_notes' INTO v_open, v_old
      FROM public.records r
     WHERE r.model_id = NEW.model_id
       AND r.id <> NEW.id
       AND r.data->>'client_id' = NEW.data->>'client_id'
       AND COALESCE(r.data->>'request_status', 'received') NOT IN ('fulfilled', 'client_dropped')
     ORDER BY r.created_at DESC
     LIMIT 1
     FOR UPDATE;
    IF v_open IS NULL THEN RETURN NEW; END IF;

    v_notes := NULLIF(btrim(COALESCE(NEW.data->>'request_notes', '')), '');
    IF v_notes IS NOT NULL AND position(v_notes IN COALESCE(v_old, '')) = 0 THEN
      UPDATE public.records
         SET data = jsonb_set(data, '{request_notes}', to_jsonb(
               CASE WHEN NULLIF(btrim(COALESCE(v_old, '')), '') IS NULL THEN v_notes
                    ELSE v_old || E'\n\n— تحديث ' || to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD') || ': ' || v_notes
               END)),
             updated_at = now()
       WHERE id = v_open;
    END IF;
    RETURN NULL;   -- the open request was updated; no duplicate
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'unanswered_request merge failed for % (%): % — creating it instead', NEW.id, SQLSTATE, SQLERRM;
    RETURN NEW;
  END;
END;
$fn$;

DROP TRIGGER IF EXISTS records_unanswered_request_merge_open ON public.records;
CREATE TRIGGER records_unanswered_request_merge_open
  BEFORE INSERT ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.tg_unanswered_request_merge_open();

COMMIT;
