-- Add leads to the RUNNING old-lead call campaign (operator, 2026-10-08:
-- «we finished all clients, release top 100 interested clients from the retired
-- list, and schedule the calls tasks for the agent»).
--
-- sales_campaign_activate plans a campaign ONCE (it refuses while
-- sales_campaign_leads has rows) and skips retired clients. This appends a given
-- list of clients to the existing plan with the SAME per-lead rules:
--   · one booking call per lead (newest open one kept and re-dated, the rest
--     cancelled; none → a new call created by the agent),
--   · every other open task of the lead goes to the agent,
--   · days fill to `daily_quota` (counting leads already on that day), working
--     days only, calls at `call_time` Riyadh,
--   · ranks continue after the current plan.
-- It does NOT un-retire anyone — the caller decides who is released; a retired
-- client is refused so a mistake is loud, not silent.

CREATE OR REPLACE FUNCTION public.sales_campaign_add_leads(
  p_clients uuid[], p_start date DEFAULT NULL, p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_clients  uuid := (SELECT id FROM public.models WHERE name = 'clients' LIMIT 1);
  v_fu       uuid := public._sales_followups_model_id();
  v_agent    uuid;
  v_quota    int;
  v_calltime time;
  v_today    date := (now() AT TIME ZONE 'Asia/Riyadh')::date;
  v_day      date;
  v_on_day   int;
  v_rank     int;
  v_keep     uuid;
  v_due      text;
  v_days     jsonb := '{}'::jsonb;
  v_created  int := 0;
  v_redated  int := 0;
  v_dupes    int := 0;
  v_reassign int := 0;
  v_skipped  jsonb := '[]'::jsonb;
  v_n        int;
  v_cid      uuid;
  v_d        jsonb;
  v_last_in  timestamptz;
  v_added    int := 0;
BEGIN
  SELECT agent_user_id, daily_quota, call_time INTO v_agent, v_quota, v_calltime
    FROM public.sales_call_campaign_settings WHERE id = 1 AND enabled;
  IF v_agent IS NULL THEN
    RAISE EXCEPTION 'sales_campaign_add_leads: no running campaign (settings disabled or no agent)' USING ERRCODE = '22023';
  END IF;
  IF p_clients IS NULL OR cardinality(p_clients) = 0 THEN
    RAISE EXCEPTION 'sales_campaign_add_leads: no clients given' USING ERRCODE = '22023';
  END IF;

  v_day := public.sales_campaign_next_workday(GREATEST(COALESCE(p_start, v_today), v_today));
  SELECT count(*) INTO v_on_day FROM public.sales_campaign_leads WHERE campaign_day = v_day;
  SELECT COALESCE(max(rank), 0) INTO v_rank FROM public.sales_campaign_leads;

  FOREACH v_cid IN ARRAY p_clients LOOP
    SELECT data INTO v_d FROM public.records WHERE id = v_cid AND model_id = v_clients;
    IF v_d IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('client', v_cid, 'why', 'not a client');
      CONTINUE;
    ELSIF COALESCE(v_d->>'is_retired', 'false') = 'true' THEN
      v_skipped := v_skipped || jsonb_build_object('client', v_cid, 'why', 'still retired');
      CONTINUE;
    ELSIF EXISTS (SELECT 1 FROM public.sales_campaign_leads WHERE client_id = v_cid) THEN
      v_skipped := v_skipped || jsonb_build_object('client', v_cid, 'why', 'already in the campaign');
      CONTINUE;
    END IF;

    WHILE v_on_day >= v_quota LOOP
      v_day := public.sales_campaign_next_workday(v_day + 1);
      SELECT count(*) INTO v_on_day FROM public.sales_campaign_leads WHERE campaign_day = v_day;
    END LOOP;
    v_on_day := v_on_day + 1;
    v_rank := v_rank + 1;
    v_added := v_added + 1;
    v_days := jsonb_set(v_days, ARRAY[v_day::text], to_jsonb(COALESCE((v_days->>v_day::text)::int, 0) + 1));
    IF p_dry_run THEN CONTINUE; END IF;

    v_due := public._iso_utc((v_day + v_calltime) AT TIME ZONE 'Asia/Riyadh');

    SELECT f.id INTO v_keep
      FROM public.records f
     WHERE f.model_id = v_fu AND public._followup_client_id_of(f.data) = v_cid::text
       AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
       AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') = 'appointment_booking_call'
     ORDER BY f.created_at DESC LIMIT 1;

    UPDATE public.records f
       SET data = f.data || jsonb_build_object(
             'followup_status', 'cancelled', 'cancel_reason', 'campaign_one_call_per_lead',
             'cancelled_at', public._iso_utc(now()), 'cancelled_by_system', true)
     WHERE f.model_id = v_fu AND public._followup_client_id_of(f.data) = v_cid::text
       AND f.id IS DISTINCT FROM v_keep
       AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
       AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') = 'appointment_booking_call';
    GET DIAGNOSTICS v_n = ROW_COUNT; v_dupes := v_dupes + v_n;

    IF v_keep IS NOT NULL THEN
      UPDATE public.records
         SET data = (data - 'fired_at' - 'escalation_reason' - 'priority') || jsonb_build_object(
               'campaign_day', v_day::text, 'scheduled_datetime', v_due,
               'sales_rep', v_agent::text, 'followup_status', 'open')
       WHERE id = v_keep;
      v_redated := v_redated + 1;
    ELSE
      v_keep := gen_random_uuid();
      INSERT INTO public.records (id, model_id, data, created_by_user_id)
      VALUES (v_keep, v_fu, jsonb_build_object(
                'client_id', v_cid::text, 'sales_rep', v_agent::text,
                'followup_type', jsonb_build_array('appointment_booking_call'),
                'followup_status', 'open', 'followup_number', 1,
                'scheduled_datetime', v_due, 'campaign_day', v_day::text,
                'creation_source', 'old_lead_campaign'),
              v_agent);
      v_created := v_created + 1;
    END IF;

    UPDATE public.records f
       SET data = f.data || jsonb_build_object('sales_rep', v_agent::text)
     WHERE f.model_id = v_fu AND public._followup_client_id_of(f.data) = v_cid::text
       AND f.id <> v_keep
       AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
       AND COALESCE(f.data->'sales_rep'->>0, f.data->>'sales_rep', '') <> v_agent::text;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_reassign := v_reassign + v_n;

    SELECT max(m.date) INTO v_last_in FROM public.chat_messages m
     WHERE m.flow = 'in' AND m.chat_wid LIKE '%@c.us'
       AND public.ksa_phone_canon('+' || split_part(m.chat_wid, '@', 1)) = public.ksa_phone_canon(v_d->>'phone_number');

    INSERT INTO public.sales_campaign_leads (client_id, campaign_day, rank, warmth, last_inbound_at, call_task_id)
    VALUES (v_cid, v_day, v_rank,
            CASE WHEN v_last_in IS NULL THEN 'never'
                 WHEN v_last_in > now() - interval '7 days' THEN 'last_7d'
                 WHEN v_last_in > now() - interval '30 days' THEN '8_30d'
                 ELSE 'over_30d' END,
            v_last_in, v_keep);
  END LOOP;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run, 'agent', v_agent, 'added', v_added,
    'per_day', v_days, 'calls_created', v_created, 'calls_redated', v_redated,
    'duplicate_calls_cancelled', v_dupes, 'other_tasks_reassigned', v_reassign, 'skipped', v_skipped);
END;
$function$;

REVOKE ALL ON FUNCTION public.sales_campaign_add_leads(uuid[], date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_campaign_add_leads(uuid[], date, boolean) TO service_role;
