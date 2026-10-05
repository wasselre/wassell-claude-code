-- ============================================================================
-- Old-lead call campaign + calls-first rules (operator, 2026-10-05).
--
-- WHAT THE OPERATOR ASKED FOR
--   A new sales agent starts calling. ~250 open clients were worked on WhatsApp
--   only (230 never called). The plan:
--     · NEW clients (from activation on) keep the normal process and are always
--       the top priority — any day, Friday and Saturday included.
--     · The old open clients are spread 40 per working day (Sun–Thu), warmest
--       first. Nothing is scheduled for old clients on Friday/Saturday.
--     · Each lead's day: the AI drafts a WhatsApp message (the agent approves
--       it; sending is paced, never a burst) AND the lead has a call task.
--     · An old lead who REPLIES to that message jumps to the top like a new
--       client, until the agent has called them.
--     · No answer on an old lead = NO second call. They continue on WhatsApp
--       (a WhatsApp follow-up the next working day, unless one is open).
--     · A lead not called on its day simply carries over (it stays open).
--     · Call results are ALWAYS set by a human: no AI suggestion for calls, and
--       the chat AI never applies a result to a call task.
--     · Chats never close calls: a rep's WhatsApp no longer cancels the open
--       booking / no-show call.
--
-- SHAPE
--   sales_call_campaign_settings (singleton) — OFF until activation; holds the
--     agent, daily quota, working days and the sending window.
--   sales_campaign_leads — one row per old lead: its day, its call task, its
--     morning message task, replied / called / no-answer.
--   sales_campaign_activate(agent, start, dry_run) — plans the days, gives every
--     lead exactly ONE booking call (re-dated to its day; duplicates cancelled),
--     reassigns open tasks to the agent and makes the agent the default rep.
--   sales_campaign_tick() — run by the 5-minute AI cron; on a working day after
--     08:00 Riyadh it opens today's leads: one fresh WhatsApp task each (older
--     open WhatsApp tasks of that lead are superseded). The cron drafts them.
--   Triggers on records: sales_rep heal, no second call for a no-answer lead,
--     one open WhatsApp task per client, campaign call completion.
--   Trigger on chat_messages: an old lead's reply → call task to the top +
--     in-app notification + push to the agent.
--   ai_send_next_slot() — paces approved follow-ups 60–180 s apart inside
--     10:00–21:00 Riyadh (old-lead messages also skip Friday/Saturday).
--
-- No function here raises SQLSTATE 40001/40P01. Every trigger catches its own
-- failures (RAISE WARNING): a bookkeeping error must never fail a record save
-- or lose an inbound WhatsApp message.
-- ============================================================================

BEGIN;

-- ── 0. helpers ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._iso_utc(p timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT to_char(p AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
$fn$;

-- ── 1. settings + leads ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.sales_call_campaign_settings (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled            boolean NOT NULL DEFAULT false,
  agent_user_id      uuid,
  daily_quota        int NOT NULL DEFAULT 40 CHECK (daily_quota BETWEEN 1 AND 500),
  start_date         date,
  -- extract(dow): 0 = Sunday … 6 = Saturday. Sun–Thu.
  working_days       int[] NOT NULL DEFAULT '{0,1,2,3,4}',
  call_time          time NOT NULL DEFAULT '09:00',
  morning_from       time NOT NULL DEFAULT '08:00',
  send_window_start  time NOT NULL DEFAULT '10:00',
  send_window_end    time NOT NULL DEFAULT '21:00',
  send_gap_min_s     int  NOT NULL DEFAULT 60  CHECK (send_gap_min_s >= 10),
  send_gap_max_s     int  NOT NULL DEFAULT 180 CHECK (send_gap_max_s >= send_gap_min_s),
  last_morning_run   date,
  last_send_slot     timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.sales_call_campaign_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.sales_call_campaign_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_call_campaign_settings_read ON public.sales_call_campaign_settings;
-- Non-sensitive: the Work Queue reads it to know who the campaign agent is.
CREATE POLICY sales_call_campaign_settings_read ON public.sales_call_campaign_settings
  FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.sales_call_campaign_settings FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.sales_call_campaign_settings FROM authenticated;

CREATE TABLE IF NOT EXISTS public.sales_campaign_leads (
  client_id        uuid PRIMARY KEY,
  campaign_day     date NOT NULL,
  rank             int  NOT NULL,
  warmth           text NOT NULL,
  last_inbound_at  timestamptz,
  call_task_id     uuid,
  message_task_id  uuid,
  status           text NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned', 'active', 'called', 'no_answer', 'done', 'skipped')),
  replied_at       timestamptz,
  called_at        timestamptz,
  call_result      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_campaign_leads_day ON public.sales_campaign_leads (campaign_day, status);
CREATE INDEX IF NOT EXISTS sales_campaign_leads_call ON public.sales_campaign_leads (call_task_id);
ALTER TABLE public.sales_campaign_leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sales_campaign_leads_read ON public.sales_campaign_leads;
CREATE POLICY sales_campaign_leads_read ON public.sales_campaign_leads
  FOR SELECT TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid()))
         OR public.wassell_app_user_id((SELECT auth.uid())) =
            (SELECT s.agent_user_id FROM public.sales_call_campaign_settings s WHERE s.id = 1));
REVOKE ALL ON public.sales_campaign_leads FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.sales_campaign_leads FROM authenticated;

-- The campaign agent approves the morning messages → must see ai_actions.
DROP POLICY IF EXISTS ai_actions_campaign_agent_select ON public.ai_actions;
CREATE POLICY ai_actions_campaign_agent_select ON public.ai_actions
  FOR SELECT TO authenticated
  USING (public.wassell_app_user_id((SELECT auth.uid())) =
         (SELECT s.agent_user_id FROM public.sales_call_campaign_settings s WHERE s.id = 1));

-- ── 2. working days ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.sales_campaign_next_workday(p_from date)
RETURNS date LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_days int[];
  v_d date := p_from;
BEGIN
  SELECT working_days INTO v_days FROM public.sales_call_campaign_settings WHERE id = 1;
  v_days := COALESCE(v_days, '{0,1,2,3,4}');
  FOR i IN 0..13 LOOP
    IF extract(dow FROM v_d)::int = ANY (v_days) THEN RETURN v_d; END IF;
    v_d := v_d + 1;
  END LOOP;
  RETURN p_from;   -- misconfigured (no working days) — never loop forever
END;
$fn$;

-- ── 3. activation: plan days, one call per lead, reassign ──────────────────

CREATE OR REPLACE FUNCTION public.sales_campaign_activate(
  p_agent uuid, p_start date DEFAULT NULL, p_dry_run boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_clients  uuid := (SELECT id FROM public.models WHERE name = 'clients' LIMIT 1);
  v_fu       uuid := public._sales_followups_model_id();
  v_appts    uuid := (SELECT id FROM public.models WHERE name = 'appointments' LIMIT 1);
  v_quota    int;
  v_today    date := (now() AT TIME ZONE 'Asia/Riyadh')::date;
  v_start    date;
  v_calltime time;
  r          record;
  v_day      date;
  v_on_day   int := 0;
  v_rank     int := 0;
  v_keep     uuid;
  v_due      text;
  v_days     jsonb := '{}'::jsonb;
  v_created  int := 0;
  v_redated  int := 0;
  v_dupes    int := 0;
  v_reassign int := 0;
  v_n        int;
BEGIN
  IF p_agent IS NULL OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_agent AND is_active) THEN
    RAISE EXCEPTION 'sales_campaign_activate: % is not an active user', p_agent USING ERRCODE = '22023';
  END IF;
  SELECT daily_quota, call_time INTO v_quota, v_calltime FROM public.sales_call_campaign_settings WHERE id = 1;
  v_start := public.sales_campaign_next_workday(COALESCE(p_start, v_today));

  IF NOT p_dry_run AND EXISTS (SELECT 1 FROM public.sales_campaign_leads) THEN
    RAISE EXCEPTION 'sales_campaign_activate: a campaign is already planned (% leads) — clear sales_campaign_leads first',
      (SELECT count(*) FROM public.sales_campaign_leads) USING ERRCODE = '22023';
  END IF;

  v_day := v_start;
  FOR r IN
    WITH open_clients AS (
      SELECT c.id, public.ksa_phone_canon(c.data->>'phone_number') AS canon
        FROM public.records c
       WHERE c.model_id = v_clients
         AND COALESCE(c.data->>'is_retired', 'false') <> 'true'
         AND COALESCE(c.data->>'client_stage', '') NOT IN ('غير مؤهل', 'خاسر', 'مغلق ناجح', 'يريد إيجار')
         -- Clients already in the appointment flow keep their confirmation calls.
         AND NOT EXISTS (
           SELECT 1 FROM public.records a
            WHERE a.model_id = v_appts AND a.data->>'client_id' = c.id::text
              AND COALESCE(a.data->>'appointment_status', '') IN ('scheduled', 'confirmed', 'rescheduled'))
         -- …and any other open call flow (confirmation, no-show, after-visit, offer…).
         AND NOT EXISTS (
           SELECT 1 FROM public.records f
            WHERE f.model_id = v_fu AND public._followup_client_id_of(f.data) = c.id::text
              AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
              AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type')
                  NOT IN ('appointment_booking_call', 'whatsapp_follow_up', 'rating_request'))
    ), last_in AS (
      SELECT public.ksa_phone_canon('+' || split_part(m.chat_wid, '@', 1)) AS canon, max(m.date) AS at
        FROM public.chat_messages m
       WHERE m.flow = 'in' AND m.chat_wid LIKE '%@c.us'
       GROUP BY 1
    )
    SELECT oc.id, li.at AS last_in,
           CASE WHEN li.at IS NULL THEN 'never'
                WHEN li.at > now() - interval '7 days' THEN 'last_7d'
                WHEN li.at > now() - interval '30 days' THEN '8_30d'
                ELSE 'over_30d' END AS warmth
      FROM open_clients oc
      LEFT JOIN last_in li ON li.canon = oc.canon
     ORDER BY li.at DESC NULLS LAST, oc.id
  LOOP
    IF v_on_day >= v_quota THEN
      v_day := public.sales_campaign_next_workday(v_day + 1);
      v_on_day := 0;
    END IF;
    v_on_day := v_on_day + 1;
    v_rank := v_rank + 1;
    v_days := jsonb_set(v_days, ARRAY[v_day::text], to_jsonb(COALESCE((v_days->>v_day::text)::int, 0) + 1));
    IF p_dry_run THEN CONTINUE; END IF;

    v_due := public._iso_utc((v_day + v_calltime) AT TIME ZONE 'Asia/Riyadh');

    -- Keep the newest open booking call, cancel the rest (one call per lead).
    SELECT f.id INTO v_keep
      FROM public.records f
     WHERE f.model_id = v_fu AND public._followup_client_id_of(f.data) = r.id::text
       AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
       AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') = 'appointment_booking_call'
     ORDER BY f.created_at DESC LIMIT 1;

    UPDATE public.records f
       SET data = f.data || jsonb_build_object(
             'followup_status', 'cancelled', 'cancel_reason', 'campaign_one_call_per_lead',
             'cancelled_at', public._iso_utc(now()), 'cancelled_by_system', true)
     WHERE f.model_id = v_fu AND public._followup_client_id_of(f.data) = r.id::text
       AND f.id IS DISTINCT FROM v_keep
       AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
       AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') = 'appointment_booking_call';
    GET DIAGNOSTICS v_n = ROW_COUNT; v_dupes := v_dupes + v_n;

    IF v_keep IS NOT NULL THEN
      UPDATE public.records
         SET data = (data - 'fired_at' - 'escalation_reason' - 'priority') || jsonb_build_object(
               'campaign_day', v_day::text, 'scheduled_datetime', v_due,
               'sales_rep', p_agent::text, 'followup_status', 'open')
       WHERE id = v_keep;
      v_redated := v_redated + 1;
    ELSE
      v_keep := gen_random_uuid();
      INSERT INTO public.records (id, model_id, data, created_by_user_id)
      VALUES (v_keep, v_fu, jsonb_build_object(
                'client_id', r.id::text, 'sales_rep', p_agent::text,
                'followup_type', jsonb_build_array('appointment_booking_call'),
                'followup_status', 'open', 'followup_number', 1,
                'scheduled_datetime', v_due, 'campaign_day', v_day::text,
                'creation_source', 'old_lead_campaign'),
              p_agent);
      v_created := v_created + 1;
    END IF;

    -- Every other open task of the lead belongs to the agent too.
    UPDATE public.records f
       SET data = f.data || jsonb_build_object('sales_rep', p_agent::text)
     WHERE f.model_id = v_fu AND public._followup_client_id_of(f.data) = r.id::text
       AND f.id <> v_keep
       AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
       AND COALESCE(f.data->'sales_rep'->>0, f.data->>'sales_rep', '') <> p_agent::text;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_reassign := v_reassign + v_n;

    INSERT INTO public.sales_campaign_leads (client_id, campaign_day, rank, warmth, last_inbound_at, call_task_id)
    VALUES (r.id, v_day, v_rank, r.warmth, r.last_in, v_keep);
  END LOOP;

  IF NOT p_dry_run THEN
    UPDATE public.sales_call_campaign_settings
       SET enabled = true, agent_user_id = p_agent, start_date = v_start, updated_at = now()
     WHERE id = 1;
    -- New clients (and every task that would default to "nobody") go to the agent.
    UPDATE public.wassell_sales_config SET default_sales_rep = p_agent, updated_at = now() WHERE id;
    IF NOT FOUND THEN
      INSERT INTO public.wassell_sales_config (id, default_sales_rep) VALUES (true, p_agent);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run, 'agent', p_agent, 'start', v_start, 'leads', v_rank,
    'per_day', v_days, 'calls_created', v_created, 'calls_redated', v_redated,
    'duplicate_calls_cancelled', v_dupes, 'other_tasks_reassigned', v_reassign);
END;
$fn$;

-- ── 4. the morning tick: open today's leads (one WhatsApp task each) ───────

CREATE OR REPLACE FUNCTION public.sales_campaign_tick()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  s        public.sales_call_campaign_settings%ROWTYPE;
  v_fu     uuid := public._sales_followups_model_id();
  v_local  timestamp := now() AT TIME ZONE 'Asia/Riyadh';
  v_today  date := (now() AT TIME ZONE 'Asia/Riyadh')::date;
  l        record;
  v_task   uuid;
  v_n      int := 0;
  v_sup    int := 0;
  v_k      int;
BEGIN
  SELECT * INTO s FROM public.sales_call_campaign_settings WHERE id = 1 FOR UPDATE;
  IF NOT FOUND OR NOT s.enabled OR s.agent_user_id IS NULL THEN RETURN jsonb_build_object('skipped', 'disabled'); END IF;
  IF NOT (extract(dow FROM v_today)::int = ANY (s.working_days)) THEN RETURN jsonb_build_object('skipped', 'not_a_working_day'); END IF;
  IF v_local::time < s.morning_from THEN RETURN jsonb_build_object('skipped', 'before_morning'); END IF;
  IF s.last_morning_run = v_today THEN RETURN jsonb_build_object('skipped', 'already_ran_today'); END IF;

  FOR l IN
    SELECT * FROM public.sales_campaign_leads
     WHERE campaign_day <= v_today AND status = 'planned'
     ORDER BY campaign_day, rank
     FOR UPDATE
  LOOP
    -- A lead that moved on since planning (lost, rent, booked…) is skipped.
    IF EXISTS (SELECT 1 FROM public.records c WHERE c.id = l.client_id
                AND (COALESCE(c.data->>'client_stage', '') IN ('غير مؤهل', 'خاسر', 'مغلق ناجح', 'يريد إيجار')
                     OR COALESCE(c.data->>'is_retired', 'false') = 'true')) THEN
      UPDATE public.sales_campaign_leads SET status = 'skipped', updated_at = now() WHERE client_id = l.client_id;
      CONTINUE;
    END IF;

    -- Older open WhatsApp tasks give way to today's message (one WhatsApp task per lead).
    UPDATE public.records f
       SET data = (f.data - 'whatsapp_state') || jsonb_build_object(
             'followup_status', 'cancelled', 'cancel_reason', 'superseded_by_campaign_message',
             'cancelled_at', public._iso_utc(now()), 'cancelled_by_system', true)
     WHERE f.model_id = v_fu AND public._followup_client_id_of(f.data) = l.client_id::text
       AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
       AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') = 'whatsapp_follow_up';
    GET DIAGNOSTICS v_k = ROW_COUNT; v_sup := v_sup + v_k;

    v_task := gen_random_uuid();
    INSERT INTO public.records (id, model_id, data, created_by_user_id)
    VALUES (v_task, v_fu, jsonb_build_object(
              'client_id', l.client_id::text, 'sales_rep', s.agent_user_id::text,
              'followup_type', jsonb_build_array('whatsapp_follow_up'),
              'followup_status', 'open', 'followup_number', 1, 'whatsapp_attempt_number', 1,
              'scheduled_datetime', public._iso_utc(now()),
              'campaign_message', 'morning', 'campaign_day', l.campaign_day::text,
              'creation_source', 'old_lead_campaign'),
            s.agent_user_id);

    UPDATE public.sales_campaign_leads
       SET status = 'active', message_task_id = v_task, updated_at = now()
     WHERE client_id = l.client_id;
    v_n := v_n + 1;
  END LOOP;

  UPDATE public.sales_call_campaign_settings SET last_morning_run = v_today, updated_at = now() WHERE id = 1;
  RETURN jsonb_build_object('opened', v_n, 'whatsapp_superseded', v_sup, 'day', v_today);
END;
$fn$;

-- ── 5. triggers on followups ────────────────────────────────────────────────

-- 5a. A task assigned to nobody / a deleted / a disabled user goes to the
-- default rep (the "First Follow-up" workflow hard-codes a user that does not
-- exist — 13 open booking calls pointed at it on 2026-10-05, so the new-client
-- push went nowhere).
CREATE OR REPLACE FUNCTION public.tg_followups_sales_rep_heal()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_rep text;
BEGIN
  IF NEW.model_id IS DISTINCT FROM public._sales_followups_model_id() THEN RETURN NEW; END IF;
  BEGIN
    v_rep := NULLIF(COALESCE(NEW.data->'sales_rep'->>0, NEW.data->>'sales_rep'), '');
    IF v_rep IS NULL OR v_rep !~* '^[0-9a-f-]{36}$'
       OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_rep::uuid AND u.is_active) THEN
      NEW.data := NEW.data || jsonb_build_object('sales_rep', public.wassell_default_sales_rep()::text);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_followups_sales_rep_heal: %', SQLERRM;
  END;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS records_followups_sales_rep_heal ON public.records;
CREATE TRIGGER records_followups_sales_rep_heal
BEFORE INSERT ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_followups_sales_rep_heal();

-- 5b. No second call for an old lead who did not answer: an automatic booking
-- call for them (the WhatsApp no-response escalation) is born cancelled.
CREATE OR REPLACE FUNCTION public.tg_followups_campaign_no_second_call()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.model_id IS DISTINCT FROM public._sales_followups_model_id() THEN RETURN NEW; END IF;
  BEGIN
    IF COALESCE(NEW.data->'followup_type'->>0, NEW.data->>'followup_type') = 'appointment_booking_call'
       AND COALESCE(NEW.data->>'campaign_day', '') = ''
       AND EXISTS (SELECT 1 FROM public.sales_campaign_leads l
                    WHERE l.client_id::text = public._followup_client_id_of(NEW.data)
                      AND l.status = 'no_answer') THEN
      NEW.data := NEW.data || jsonb_build_object(
        'followup_status', 'cancelled', 'cancel_reason', 'old_lead_no_second_call',
        'cancelled_at', public._iso_utc(now()), 'cancelled_by_system', true);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_followups_campaign_no_second_call: %', SQLERRM;
  END;
  RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS records_followups_campaign_no_second_call ON public.records;
CREATE TRIGGER records_followups_campaign_no_second_call
BEFORE INSERT ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_followups_campaign_no_second_call();

-- 5c. After a follow-up write: one open WhatsApp task per client, and the
-- campaign call's result.
CREATE OR REPLACE FUNCTION public.tg_followups_after_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_type    text;
  v_client  text;
  v_status  text;
  v_old_st  text;
  v_result  text;
  v_due     text;
  v_lead    public.sales_campaign_leads%ROWTYPE;
BEGIN
  IF NEW.model_id IS DISTINCT FROM public._sales_followups_model_id() THEN RETURN NULL; END IF;
  BEGIN
    v_type   := COALESCE(NEW.data->'followup_type'->>0, NEW.data->>'followup_type');
    v_client := public._followup_client_id_of(NEW.data);
    v_status := COALESCE(NULLIF(NEW.data->>'followup_status', ''), 'open');

    -- One open WhatsApp task per client: a NEW one supersedes the older ones
    -- (e.g. «interested» on a call used to add a second WhatsApp task).
    IF TG_OP = 'INSERT' AND v_type = 'whatsapp_follow_up' AND v_status IN ('open', 'in_progress') AND v_client IS NOT NULL THEN
      UPDATE public.records f
         SET data = (f.data - 'whatsapp_state') || jsonb_build_object(
               'followup_status', 'cancelled', 'cancel_reason', 'superseded_by_newer_whatsapp_task',
               'cancelled_at', public._iso_utc(now()), 'cancelled_by_system', true,
               'superseded_by_followup_id', NEW.id::text)
       WHERE f.model_id = NEW.model_id AND f.id <> NEW.id
         AND public._followup_client_id_of(f.data) = v_client
         AND f.created_at <= NEW.created_at
         AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
         AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') = 'whatsapp_follow_up';
    END IF;

    -- The campaign call was closed.
    IF TG_OP = 'UPDATE' AND v_type = 'appointment_booking_call' AND COALESCE(NEW.data->>'campaign_day', '') <> '' THEN
      v_old_st := COALESCE(NULLIF(OLD.data->>'followup_status', ''), 'open');
      IF v_old_st IN ('open', 'in_progress') AND v_status IN ('completed', 'cancelled', 'skipped') THEN
        SELECT * INTO v_lead FROM public.sales_campaign_leads WHERE call_task_id = NEW.id FOR UPDATE;
        IF FOUND THEN
          v_result := NULLIF(NEW.data->>'call_result', '');
          UPDATE public.sales_campaign_leads
             SET status = CASE WHEN v_status <> 'completed' THEN 'done'
                               WHEN v_result = 'no_answer' THEN 'no_answer' ELSE 'called' END,
                 called_at = CASE WHEN v_status = 'completed' THEN now() ELSE called_at END,
                 call_result = v_result, updated_at = now()
           WHERE client_id = v_lead.client_id;

          -- What the booking-call workflow's no-answer branch did (that branch
          -- now skips campaign calls so it does not book a second call).
          IF v_status = 'completed' AND v_result = 'no_answer' THEN
            UPDATE public.records
               SET data = data || jsonb_build_object('client_stage', 'الاتصال لحجز موعد', 'client_status', 'لا يوجد رد')
             WHERE id = v_lead.client_id;
          END IF;

          -- No answer: no second call. WhatsApp the next working day, unless a
          -- WhatsApp task is already open (this morning's message keeps going).
          IF v_status = 'completed' AND v_result = 'no_answer'
             AND NOT EXISTS (SELECT 1 FROM public.records f
                              WHERE f.model_id = NEW.model_id AND public._followup_client_id_of(f.data) = v_client
                                AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
                                AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') = 'whatsapp_follow_up') THEN
            v_due := public._iso_utc((public.sales_campaign_next_workday(((now() AT TIME ZONE 'Asia/Riyadh')::date) + 1)
                                      + time '10:00') AT TIME ZONE 'Asia/Riyadh');
            INSERT INTO public.records (id, model_id, data, created_by_user_id)
            VALUES (gen_random_uuid(), NEW.model_id, jsonb_build_object(
                      'client_id', v_client,
                      'sales_rep', COALESCE(NEW.data->'sales_rep'->>0, NEW.data->>'sales_rep'),
                      'followup_type', jsonb_build_array('whatsapp_follow_up'),
                      'followup_status', 'open', 'followup_number', 1, 'whatsapp_attempt_number', 1,
                      'scheduled_datetime', v_due, 'campaign_message', 'no_answer',
                      'previous_followup_id', NEW.id::text, 'creation_source', 'old_lead_no_answer'),
                    NULL);
          END IF;
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_followups_after_write % (%): %', NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS records_followups_after_write ON public.records;
CREATE TRIGGER records_followups_after_write
AFTER INSERT OR UPDATE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_followups_after_write();

-- ── 6. an old lead replies → call them first ───────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_chat_messages_campaign_reply()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_client  text;
  v_digits  text;
  v_lead    public.sales_campaign_leads%ROWTYPE;
  v_sent    timestamptz;
  v_agent   uuid;
  v_name    text;
BEGIN
  IF NEW.flow IS DISTINCT FROM 'in' THEN RETURN NULL; END IF;
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.sales_campaign_leads WHERE status = 'active' AND replied_at IS NULL) THEN
      RETURN NULL;   -- cheap exit for the common case
    END IF;
    IF NEW.conversation_record_id IS NOT NULL THEN
      SELECT data->>'client_link' INTO v_client FROM public.records WHERE id = NEW.conversation_record_id;
    END IF;
    IF NULLIF(v_client, '') IS NULL THEN
      v_digits := substring(COALESCE(NEW.chat_wid, '') FROM '^(\d{8,15})@');
      IF v_digits IS NOT NULL THEN v_client := public.find_client_id_by_phone('+' || v_digits)::text; END IF;
    END IF;
    IF v_client IS NULL OR v_client !~* '^[0-9a-f-]{36}$' THEN RETURN NULL; END IF;

    SELECT * INTO v_lead FROM public.sales_campaign_leads
     WHERE client_id = v_client::uuid AND status = 'active' AND replied_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- Only a reply AFTER this morning's message went out.
    SELECT public.try_timestamptz(NULLIF(data->>'sent_at', '')) INTO v_sent FROM public.records WHERE id = v_lead.message_task_id;
    IF v_sent IS NULL OR NEW.date < v_sent THEN RETURN NULL; END IF;

    UPDATE public.sales_campaign_leads SET replied_at = NEW.date, updated_at = now() WHERE client_id = v_lead.client_id;

    UPDATE public.records
       SET data = (data - 'fired_at') || jsonb_build_object(
             'priority', 'high', 'campaign_replied_at', public._iso_utc(NEW.date),
             'scheduled_datetime', public._iso_utc(now()))
     WHERE id = v_lead.call_task_id
       AND COALESCE(NULLIF(data->>'followup_status', ''), 'open') IN ('open', 'in_progress');
    IF NOT FOUND THEN RETURN NULL; END IF;   -- already called

    SELECT agent_user_id INTO v_agent FROM public.sales_call_campaign_settings WHERE id = 1;
    SELECT COALESCE(NULLIF(data->>'client_name', ''), 'عميل') INTO v_name FROM public.records WHERE id = v_lead.client_id;
    IF v_agent IS NOT NULL THEN
      INSERT INTO public.ai_notifications (source, severity, title, body, chat_wid, chat_record_id, client_record_id, target_user_id, meta)
      VALUES ('sales', 'action', 'عميل قديم رد — اتصل الآن', v_name || ' رد على رسالة اليوم ولم نتصل به بعد.',
              NEW.chat_wid, NEW.conversation_record_id, v_lead.client_id, v_agent,
              jsonb_build_object('kind', 'campaign_replied', 'call_task_id', v_lead.call_task_id));
      INSERT INTO public.push_outbox (user_id, kind, title, body, url, tag, dedupe_key)
      VALUES (v_agent, 'campaign_replied', '📞 عميل قديم رد — اتصل الآن', v_name,
              '/model/followups/' || v_lead.call_task_id || '?returnTo=%2Fsales%2Fmy-tasks',
              'followup-' || v_lead.call_task_id, 'campaign_replied:' || v_lead.call_task_id)
      ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_chat_messages_campaign_reply % (%): %', NEW.id, SQLSTATE, SQLERRM;
  END;
  RETURN NULL;
END;
$fn$;
DROP TRIGGER IF EXISTS chat_messages_campaign_reply ON public.chat_messages;
CREATE TRIGGER chat_messages_campaign_reply
AFTER INSERT ON public.chat_messages
FOR EACH ROW WHEN (NEW.flow = 'in')
EXECUTE FUNCTION public.tg_chat_messages_campaign_reply();

-- ── 7. paced sending of approved follow-ups ─────────────────────────────────

CREATE OR REPLACE FUNCTION public.ai_send_next_slot(p_old_lead boolean DEFAULT false)
RETURNS timestamptz LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  s       public.sales_call_campaign_settings%ROWTYPE;
  v_gap   interval;
  v_slot  timestamptz;
  v_local timestamp;
  v_day   date;
BEGIN
  SELECT * INTO s FROM public.sales_call_campaign_settings WHERE id = 1 FOR UPDATE;
  v_gap  := make_interval(secs => s.send_gap_min_s + floor(random() * (s.send_gap_max_s - s.send_gap_min_s + 1)));
  v_slot := CASE WHEN s.last_send_slot IS NULL OR s.last_send_slot + v_gap < now() THEN now()
                 ELSE s.last_send_slot + v_gap END;

  -- Inside the sending window (Riyadh); outside it → the next window opening.
  FOR i IN 0..14 LOOP
    v_local := v_slot AT TIME ZONE 'Asia/Riyadh';
    v_day := v_local::date;
    IF v_local::time < s.send_window_start THEN
      v_slot := (v_day + s.send_window_start) AT TIME ZONE 'Asia/Riyadh';
      v_local := v_slot AT TIME ZONE 'Asia/Riyadh';
    ELSIF v_local::time >= s.send_window_end THEN
      v_slot := ((v_day + 1) + s.send_window_start) AT TIME ZONE 'Asia/Riyadh';
      CONTINUE;
    END IF;
    -- Old leads: nothing on a non-working day.
    IF p_old_lead AND NOT (extract(dow FROM v_local::date)::int = ANY (s.working_days)) THEN
      v_slot := ((v_local::date + 1) + s.send_window_start) AT TIME ZONE 'Asia/Riyadh';
      CONTINUE;
    END IF;
    EXIT;
  END LOOP;

  UPDATE public.sales_call_campaign_settings SET last_send_slot = v_slot WHERE id = 1;
  RETURN v_slot;
END;
$fn$;

-- ── 8. drafts: old-lead messages have their own pass ───────────────────────
-- Same rules as before, plus p_campaign: true = only old-lead message tasks
-- (they are drafted even though the lead has an open call — that is the plan),
-- false = only ordinary tasks, NULL = both. The "last word ours" rule is
-- relaxed for old-lead messages (the 2-hour quiet rule still applies).
DROP FUNCTION IF EXISTS public.ai_followup_candidates(int);
CREATE OR REPLACE FUNCTION public.ai_followup_candidates(p_limit int DEFAULT 10, p_campaign boolean DEFAULT NULL)
 RETURNS TABLE (followup_id uuid, client_id uuid, chat_wid text, chat_record_id uuid, attempt int, due_at timestamptz, campaign text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
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
   WHERE COALESCE(cl.data->>'client_stage', '') NOT IN ('خاسر', 'مغلق ناجح', 'غير مؤهل', 'يريد إيجار', 'طلب غير مجاب')
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
   ORDER BY (f.campaign IS NOT NULL) DESC, f.due ASC
   LIMIT GREATEST(1, LEAST(p_limit, 50));
$function$;

-- ── 9. call results are human: no AI for calls ─────────────────────────────

ALTER TABLE public.ai_automation_settings
  ADD COLUMN IF NOT EXISTS call_result_ai boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.tg_records_enqueue_call_analysis()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_terminal CONSTANT text[] := ARRAY['completed','no_answer','missed','rejected_by_callee','rejected_by_caller','failed','cancelled'];
BEGIN
  IF NEW.model_id IS DISTINCT FROM public._sales_phone_calls_model_id() THEN RETURN NEW; END IF;
  -- Operator 2026-10-05: call results are always set by a human.
  IF NOT COALESCE((SELECT call_result_ai FROM public.ai_automation_settings WHERE id = 1), false) THEN RETURN NEW; END IF;
  IF NEW.data->>'direction' IS DISTINCT FROM 'outbound' THEN RETURN NEW; END IF;
  IF NOT (COALESCE(NEW.data->>'status','') = ANY (v_terminal)) THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.data->>'status' IS NOT DISTINCT FROM NEW.data->>'status'
     AND OLD.data->>'transcription_text' IS NOT DISTINCT FROM NEW.data->>'transcription_text'
     AND OLD.data->>'client_link' IS NOT DISTINCT FROM NEW.data->>'client_link'
  THEN RETURN NEW; END IF;

  PERFORM public.call_result_suggestion_enqueue(NEW.id);
  RETURN NEW;
END;
$function$;

-- Retire pending call suggestions so no popup asks to confirm an AI answer.
UPDATE public.call_result_suggestions SET status = 'cancelled', finished_at = now()
 WHERE status IN ('queued', 'running', 'ready');

-- The chat AI reads only WhatsApp tasks (it never proposes a call result).
CREATE OR REPLACE FUNCTION public._cos_match_open_followup(p_client uuid)
 RETURNS TABLE(followup_id uuid, followup_type text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT f.id, COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type')
  FROM public.records f
  WHERE f.model_id = public._sales_followups_model_id()
    AND public._followup_client_id_of(f.data) = p_client::text
    AND COALESCE(NULLIF(f.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
    AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') = 'whatsapp_follow_up'
  ORDER BY f.created_at DESC
  LIMIT 1;
$function$;

-- Ready chat readings that point at a call task are retired.
UPDATE public.chat_outcome_suggestions SET status = 'superseded', finished_at = now()
 WHERE status IN ('queued', 'ready') AND followup_type IS DISTINCT FROM 'whatsapp_follow_up' AND followup_type IS NOT NULL;

-- ── 10. the booking-call workflow: an old lead's no-answer is NOT re-called ─
UPDATE public.workflows w
   SET branches = (
     SELECT jsonb_agg(
              CASE WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(b->'conditions') c
                                 WHERE c->>'field_id' = 'call_result' AND c->>'value' = 'no_answer')
                        AND EXISTS (SELECT 1 FROM jsonb_array_elements(b->'conditions') c
                                     WHERE c->>'field_id' = 'followup_number' AND c->>'operator' = 'less_than')
                        AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(b->'conditions') c
                                         WHERE c->>'field_id' = 'campaign_day')
                   THEN jsonb_set(b, '{conditions}', (b->'conditions') || jsonb_build_array(jsonb_build_object(
                          'id', 'c0a1d0e5-0000-4000-8000-0000000000c1', 'field_id', 'campaign_day',
                          'operator', 'is_empty', 'value', '')))
                   ELSE b END
              ORDER BY ord)
       FROM jsonb_array_elements(w.branches) WITH ORDINALITY AS x(b, ord)),
       updated_at = now()
 WHERE w.id = 'd997425a-0c8d-48c4-afef-b5792792cfae';

-- ── 11. chats never close calls ────────────────────────────────────────────
-- Re-emitted from the LIVE definition (identical to 2026-09-27_03) with ONLY the
-- cancel list narrowed to WhatsApp tasks.

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

-- ── grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.sales_campaign_next_workday(date)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_campaign_activate(uuid, date, boolean)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_campaign_tick()                          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_send_next_slot(boolean)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ai_followup_candidates(int, boolean)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_followups_sales_rep_heal()                  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_followups_campaign_no_second_call()         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_followups_after_write()                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_chat_messages_campaign_reply()              FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_campaign_next_workday(date)           TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_campaign_activate(uuid, date, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_campaign_tick()                       TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_send_next_slot(boolean)                  TO service_role;
GRANT EXECUTE ON FUNCTION public.ai_followup_candidates(int, boolean)        TO service_role;

COMMIT;
