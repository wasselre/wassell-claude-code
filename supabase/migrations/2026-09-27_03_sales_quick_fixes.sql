-- ============================================================================
-- Sales quick fixes (2026-09-27, operator-approved: 1 yes, 2 yes, 3 yes)
--
-- 1. BOT ≠ REP. reconcile_outbound_whatsapp ignored nothing the bot sent: a
--    bot reply (send_source 'ai', 268 in the last 30 days) cancelled the
--    client's open booking / no-show call and restarted the 24h "waiting for
--    reply" clock — overwriting the «client replied» state the inbound message
--    had just set. Now an 'ai' send touches no task at all. Re-emitted from
--    2026-09-27_02 with ONLY the «bot» early return added.
--
-- 2. MISSED INCOMING CALL → CALL-BACK TASK. A missed inbound call from a known
--    client created nothing. Now: the client's open CALL task (any non-WhatsApp
--    type) is bumped to high priority and due now; if there is none, a
--    high-priority booking call due now is created. The task carries
--    missed_call_id (dedupe — Hatif writes each call several times) and
--    missed_call_at. A retired client is brought back (same as an inbound
--    WhatsApp). Unknown numbers get nothing — auto-creating clients was
--    declined by the operator. Closed-won clients are skipped.
--    Measured: 7 missed inbound calls in 30 days, 1 from a known client.
--
-- 3. THE NO-TASK CHECK RUNS HOURLY. reconcile_stranded_clients kept a
--    once-per-Riyadh-day guard; the cron moves to hourly (vercel.json) and the
--    guard becomes "not within the last 50 minutes". Its tasks now carry a UTC
--    timestamp (was Riyadh wall-clock without an offset, which the due-sweeper
--    compared as text and read 3 hours late).
-- ============================================================================

BEGIN;

-- ── 1. bot ≠ rep ───────────────────────────────────────────────────────────

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
  IF v_stage IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار', 'طلب غير مجاب') THEN RETURN 0; END IF;

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
               AND r.data->'followup_type' ?| ARRAY['appointment_booking_call','no_show_recovery_call','whatsapp_follow_up'])
         OR (jsonb_typeof(r.data->'followup_type') = 'string'
               AND r.data->>'followup_type' = ANY(ARRAY['appointment_booking_call','no_show_recovery_call','whatsapp_follow_up'])) )
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

-- ── 2. missed incoming call → call-back task ────────────────────────────────

CREATE OR REPLACE FUNCTION public.missed_call_create_task(p_call uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_call      public.records%ROWTYPE;
  v_fu_model  uuid := public._sales_followups_model_id();
  v_client    uuid;
  v_cdata     jsonb;
  v_owner     uuid;
  v_task      uuid;
  v_now_iso   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_at        text;
BEGIN
  SELECT * INTO v_call FROM public.records WHERE id = p_call;
  IF NOT FOUND THEN RETURN 'no_call'; END IF;

  IF v_call.data->>'client_link' ~* '^[0-9a-f-]{36}$' THEN
    v_client := (v_call.data->>'client_link')::uuid;
  ELSIF NULLIF(v_call.data->>'customer_phone', '') IS NOT NULL THEN
    v_client := public.find_client_id_by_phone(v_call.data->>'customer_phone');
  END IF;
  IF v_client IS NULL THEN RETURN 'unknown_caller'; END IF;   -- operator: no auto-created clients

  SELECT data INTO v_cdata FROM public.records WHERE id = v_client;
  IF v_cdata IS NULL THEN RETURN 'client_missing'; END IF;
  IF v_cdata->>'client_stage' = 'مغلق ناجح' THEN RETURN 'closed_won'; END IF;

  -- Hatif writes each call several times — one task per missed call.
  IF EXISTS (SELECT 1 FROM public.records f
             WHERE f.model_id = v_fu_model AND f.data->>'missed_call_id' = p_call::text) THEN
    RETURN 'already_handled';
  END IF;

  v_at := COALESCE(NULLIF(v_call.data->>'call_time', ''), to_char(v_call.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));

  -- A client who calls us is not retired (mirrors the inbound-WhatsApp rule).
  IF (v_cdata->>'is_retired')::boolean IS TRUE THEN
    UPDATE public.records
       SET data = data || jsonb_build_object('is_retired', false, 'retired_at', NULL, 'retired_reason', NULL)
     WHERE id = v_client;
  END IF;

  -- Their open CALL task, if any (WhatsApp tasks are a different channel).
  SELECT f.id INTO v_task
  FROM public.records f
  WHERE f.model_id = v_fu_model
    AND public._followup_client_id_of(f.data) = v_client::text
    AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') IS DISTINCT FROM 'whatsapp_follow_up'
  ORDER BY f.created_at DESC
  LIMIT 1;

  IF v_task IS NOT NULL THEN
    UPDATE public.records
       SET data = (data - 'fired_at') || jsonb_build_object(
             'priority', 'high',
             'scheduled_datetime', v_now_iso,
             'missed_call_id', p_call::text,
             'missed_call_at', v_at)
     WHERE id = v_task;
    RETURN 'bumped';
  END IF;

  v_owner := CASE WHEN v_cdata->>'client_owner' ~* '^[0-9a-f-]{36}$'
                  THEN (SELECT u.id FROM public.users u WHERE u.id = (v_cdata->>'client_owner')::uuid AND u.is_active) END;
  v_owner := COALESCE(v_owner, public.wassell_default_sales_rep());

  INSERT INTO public.records (id, model_id, data, created_by_user_id)
  VALUES (gen_random_uuid(), v_fu_model, jsonb_build_object(
            'client_id',          v_client::text,
            'sales_rep',          v_owner::text,
            'followup_type',      jsonb_build_array('appointment_booking_call'),
            'followup_status',    'open',
            'followup_number',    1,
            'priority',           'high',
            'scheduled_datetime', v_now_iso,
            'missed_call_id',     p_call::text,
            'missed_call_at',     v_at,
            'creation_source',    'missed_inbound_call'),
          v_owner);
  RETURN 'created';
END;
$fn$;

/** Never breaks call ingest: a failure becomes a WARNING in the Postgres log. */
CREATE OR REPLACE FUNCTION public.tg_records_missed_call_task()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.model_id IS DISTINCT FROM public._sales_phone_calls_model_id() THEN RETURN NEW; END IF;
  IF NEW.data->>'direction' IS DISTINCT FROM 'inbound' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.data->>'status', '') NOT IN ('missed', 'no_answer') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.data->>'status' IS NOT DISTINCT FROM NEW.data->>'status'
     AND OLD.data->>'client_link' IS NOT DISTINCT FROM NEW.data->>'client_link' THEN
    RETURN NEW;
  END IF;
  BEGIN
    PERFORM public.missed_call_create_task(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'missed_call_create_task failed for call % (%): %', NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS records_missed_call_task ON public.records;
CREATE TRIGGER records_missed_call_task
AFTER INSERT OR UPDATE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_records_missed_call_task();

REVOKE ALL ON FUNCTION public.missed_call_create_task(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_records_missed_call_task() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.missed_call_create_task(uuid) TO service_role;

-- ── 3. the no-task check runs hourly ────────────────────────────────────────

ALTER TABLE public.next_action_backstop_state ADD COLUMN IF NOT EXISTS last_run_at timestamptz;

CREATE OR REPLACE FUNCTION public.reconcile_stranded_clients(p_default_owner uuid DEFAULT NULL::uuid, p_grace_minutes integer DEFAULT 60, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_clients   uuid;
  v_followups uuid;
  v_appts     uuid;
  v_today     date        := (now() AT TIME ZONE 'Asia/Riyadh')::date;
  v_now_iso   text        := to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_cutoff    timestamptz := now() - make_interval(mins => GREATEST(p_grace_minutes, 0));
  v_default   uuid        := p_default_owner;
  r           record;
  v_owner     uuid;
  v_defaulted boolean;
  v_appt_id   text;
  v_appt_stat text;
  v_existing  uuid;
  v_branch    text;
  v_actions   jsonb := '[]'::jsonb;
  v_created   int := 0;
  v_reopened  int := 0;
  v_skipped   int := 0;
BEGIN
  SELECT id INTO v_clients   FROM models WHERE name = 'clients'      LIMIT 1;
  SELECT id INTO v_followups FROM models WHERE name = 'followups'    LIMIT 1;
  SELECT id INTO v_appts     FROM models WHERE name = 'appointments' LIMIT 1;
  IF v_clients IS NULL OR v_followups IS NULL THEN
    RETURN jsonb_build_object('error', 'clients/followups model missing');
  END IF;

  IF v_default IS NULL THEN
    SELECT u.id INTO v_default
    FROM users u JOIN profiles pr ON pr.id = u.profile_id
    WHERE pr.is_admin AND u.is_active
    ORDER BY (u.email = 'r.abanumay@wassel.re') DESC, u.created_at ASC
    LIMIT 1;
  END IF;

  -- Hourly now (was once per Riyadh day). 50 minutes, not 60, so a cron tick
  -- that fires a few seconds early is not skipped.
  IF NOT p_dry_run AND EXISTS (
        SELECT 1 FROM next_action_backstop_state WHERE last_run_at > now() - interval '50 minutes') THEN
    RETURN jsonb_build_object('skipped', 'ran_recently');
  END IF;

  FOR r IN
    SELECT * FROM (
      SELECT c.id AS client_id,
             NULLIF(c.data->>'client_owner', '') AS owner_raw,
             c.data->>'client_stage' AS stage,
             GREATEST(
               c.updated_at,
               COALESCE((SELECT max(f.updated_at) FROM records f
                          WHERE f.model_id = v_followups
                            AND f.data->>'client_id' = c.id::text), c.updated_at)
             ) AS last_activity
      FROM records c
      WHERE c.model_id = v_clients
        AND COALESCE(c.data->>'is_retired', 'false') <> 'true'
        AND COALESCE(c.data->>'client_stage', '') NOT IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار', 'طلب غير مجاب')
        AND NOT EXISTS (
          SELECT 1 FROM records f
          WHERE f.model_id = v_followups
            AND f.data->>'client_id' = c.id::text
            AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress'))
        AND (v_appts IS NULL OR NOT EXISTS (
          SELECT 1 FROM records a
          WHERE a.model_id = v_appts
            AND a.data->>'client_id' = c.id::text
            AND COALESCE(a.data->>'appointment_status', '') IN ('scheduled', 'confirmed', 'rescheduled')
            AND a.data->>'appointment_date' ~ '^\d{4}-\d{2}-\d{2}'
            AND left(a.data->>'appointment_date', 10)::date >= v_today))
    ) s
    WHERE s.last_activity <= v_cutoff
  LOOP
    v_owner := NULL;
    IF r.owner_raw ~ '^[0-9a-fA-F-]{36}$' THEN
      SELECT id INTO v_owner FROM users WHERE id = r.owner_raw::uuid AND is_active;
    END IF;
    v_defaulted := (v_owner IS NULL);
    IF v_owner IS NULL THEN v_owner := v_default; END IF;

    v_appt_id := NULL; v_appt_stat := NULL;
    IF v_appts IS NOT NULL THEN
      SELECT a.id::text, a.data->>'appointment_status'
        INTO v_appt_id, v_appt_stat
      FROM records a
      WHERE a.model_id = v_appts AND a.data->>'client_id' = r.client_id::text
      ORDER BY a.created_at DESC LIMIT 1;
    END IF;

    v_branch := CASE WHEN v_appt_stat = 'no_show' AND v_appt_id IS NOT NULL
                     THEN 'no_show_recovery_call' ELSE 'whatsapp_follow_up' END;

    IF p_dry_run THEN
      v_actions := v_actions || jsonb_build_object(
        'client_id', r.client_id, 'stage', r.stage,
        'owner', v_owner, 'owner_defaulted', v_defaulted,
        'branch', v_branch,
        'appointment_id', CASE WHEN v_branch = 'no_show_recovery_call' THEN v_appt_id END,
        'last_activity', r.last_activity);
      CONTINUE;
    END IF;

    IF v_owner IS NULL THEN
      v_skipped := v_skipped + 1;
      v_actions := v_actions || jsonb_build_object('client_id', r.client_id, 'branch', 'SKIPPED_no_owner');
      CONTINUE;
    END IF;

    IF v_branch = 'no_show_recovery_call' THEN
      SELECT f.id INTO v_existing
      FROM records f
      WHERE f.model_id = v_followups
        AND f.data->>'appointment_id' = v_appt_id
        AND ((jsonb_typeof(f.data->'followup_type') = 'array' AND f.data->'followup_type' ? 'no_show_recovery_call')
              OR f.data->>'followup_type' = 'no_show_recovery_call')
      ORDER BY f.created_at DESC LIMIT 1;

      IF v_existing IS NOT NULL THEN
        UPDATE records
        SET data = (data - 'cancelled_at' - 'cancel_reason' - 'cancelled_by_system'
                        - 'cancelled_by_event_type' - 'cancelled_by_event_id' - 'fired_at')
                   || jsonb_build_object(
                        'followup_status', 'open',
                        'scheduled_datetime', v_now_iso,
                        'sales_rep', v_owner::text,
                        'creation_source', 'next_action_backstop',
                        'backstop_reopened_at', v_now_iso),
            updated_at = now()
        WHERE id = v_existing;
        v_reopened := v_reopened + 1;
      ELSE
        INSERT INTO records (id, model_id, data, created_by_user_id)
        VALUES (gen_random_uuid(), v_followups, jsonb_build_object(
                  'client_id', r.client_id::text,
                  'sales_rep', v_owner::text,
                  'followup_type', jsonb_build_array('no_show_recovery_call'),
                  'followup_status', 'open',
                  'appointment_id', v_appt_id,
                  'scheduled_datetime', v_now_iso,
                  'creation_source', 'next_action_backstop'),
                v_owner);
        v_created := v_created + 1;
      END IF;
    ELSE
      INSERT INTO records (id, model_id, data, created_by_user_id)
      VALUES (gen_random_uuid(), v_followups, jsonb_build_object(
                'client_id', r.client_id::text,
                'sales_rep', v_owner::text,
                'followup_type', jsonb_build_array('whatsapp_follow_up'),
                'followup_status', 'open',
                'scheduled_datetime', v_now_iso,
                'creation_source', 'next_action_backstop'),
              v_owner);
      v_created := v_created + 1;
    END IF;

    v_actions := v_actions || jsonb_build_object(
      'client_id', r.client_id, 'owner', v_owner,
      'owner_defaulted', v_defaulted, 'branch', v_branch);
  END LOOP;

  IF NOT p_dry_run THEN
    UPDATE next_action_backstop_state SET last_run_on = v_today, last_run_at = now() WHERE singleton;
  END IF;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run, 'date', v_today, 'grace_minutes', p_grace_minutes,
    'default_owner', v_default,
    'created', v_created, 'reopened', v_reopened, 'skipped_no_owner', v_skipped,
    'count', jsonb_array_length(v_actions), 'actions', v_actions);
END;
$function$;

COMMIT;
