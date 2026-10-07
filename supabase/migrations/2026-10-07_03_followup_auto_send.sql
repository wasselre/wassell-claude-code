-- ============================================================================
-- AI follow-up messages go out WITHOUT approval (operator, 2026-10-07: «remove
-- the approval because now the agent is good … the temporary ~250 clients
-- should go automatically every day at 12 pm»).
--
-- 1. ai_automation_settings.followup_auto_send — the cron sends each follow-up
--    the moment it is written (api/_lib/salesAgent/followupSend.ts), and any
--    draft still waiting from the approval days. Turn it off and drafts wait
--    for a person again in /api/ai-actions.
-- 2. sales_call_campaign_settings.campaign_send_time — old-lead (campaign)
--    messages start at this Riyadh time (12:00), paced 60–180 s apart as
--    before, working days only. ai_send_next_slot honours it for old leads;
--    ordinary follow-ups keep the 10:00–21:00 window. Same signature, so the
--    deployed code keeps working.
-- ============================================================================
BEGIN;

ALTER TABLE public.ai_automation_settings
  ADD COLUMN IF NOT EXISTS followup_auto_send boolean NOT NULL DEFAULT false;
UPDATE public.ai_automation_settings SET followup_auto_send = true, updated_at = now() WHERE id = 1;

ALTER TABLE public.sales_call_campaign_settings
  ADD COLUMN IF NOT EXISTS campaign_send_time time NOT NULL DEFAULT '12:00';

CREATE OR REPLACE FUNCTION public.ai_send_next_slot(p_old_lead boolean DEFAULT false)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s       public.sales_call_campaign_settings%ROWTYPE;
  v_gap   interval;
  v_slot  timestamptz;
  v_local timestamp;
  v_day   date;
  v_start time;
BEGIN
  SELECT * INTO s FROM public.sales_call_campaign_settings WHERE id = 1 FOR UPDATE;
  v_gap  := make_interval(secs => s.send_gap_min_s + floor(random() * (s.send_gap_max_s - s.send_gap_min_s + 1)));
  v_slot := CASE WHEN s.last_send_slot IS NULL OR s.last_send_slot + v_gap < now() THEN now()
                 ELSE s.last_send_slot + v_gap END;
  -- Old leads open at the campaign's send time (12:00), never before the window.
  v_start := CASE WHEN p_old_lead THEN greatest(s.send_window_start, s.campaign_send_time) ELSE s.send_window_start END;

  -- Inside the sending window (Riyadh); outside it → the next window opening.
  FOR i IN 0..14 LOOP
    v_local := v_slot AT TIME ZONE 'Asia/Riyadh';
    v_day := v_local::date;
    IF v_local::time < v_start THEN
      v_slot := (v_day + v_start) AT TIME ZONE 'Asia/Riyadh';
      v_local := v_slot AT TIME ZONE 'Asia/Riyadh';
    ELSIF v_local::time >= s.send_window_end THEN
      v_slot := ((v_day + 1) + v_start) AT TIME ZONE 'Asia/Riyadh';
      CONTINUE;
    END IF;
    -- Old leads: nothing on a non-working day.
    IF p_old_lead AND NOT (extract(dow FROM v_local::date)::int = ANY (s.working_days)) THEN
      v_slot := ((v_local::date + 1) + v_start) AT TIME ZONE 'Asia/Riyadh';
      CONTINUE;
    END IF;
    EXIT;
  END LOOP;

  UPDATE public.sales_call_campaign_settings SET last_send_slot = v_slot WHERE id = 1;
  RETURN v_slot;
END;
$function$;

COMMIT;
