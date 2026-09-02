-- Client retirement — Part 6: a retired client generates no work.
--
-- Retiring a client hides it from lists + counts, but its OPEN follow-up tasks
-- were still live — they showed in task queues and, worse, the on-due sweeper
-- (api/sweep-due-followups.ts) could still fire WhatsApp reminders/auto-actions
-- at a retired (dormant) contact.
--
-- Fix, in ONE place: when a client flips to retired, cancel its open/in-progress
-- follow-ups. Because the sweeper and every task queue key on OPEN status
-- (the sweeper explicitly skips completed/cancelled/skipped), a cancelled task
-- silently drops out of both — no per-surface guard to drift. A re-engaged
-- client auto-un-retires on their inbound message (2026-09-08_03) and the
-- WhatsApp activity bridge forms a fresh follow-up, so cancelled history stays
-- cancelled and new work starts clean.
--
-- Two parts: (1) the trigger for every future retire (the Retire button + any
-- path); (2) a one-time cancel of the follow-ups already open on the 670
-- clients bulk-retired by 2026-09-08_05 (that ran before this trigger existed).
-- Completed & cancelled history is never touched. Snapshot kept.

-- 1. Trigger: cancel open follow-ups when a client is retired -----------------
CREATE OR REPLACE FUNCTION public.clients_cancel_followups_on_retire()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_clients_model_id uuid;
  v_followups_model_id uuid;
BEGIN
  SELECT id INTO v_clients_model_id   FROM public.models WHERE name = 'clients';
  SELECT id INTO v_followups_model_id FROM public.models WHERE name = 'followups';
  IF v_clients_model_id IS NULL OR v_followups_model_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Only act on the clients model (the WHEN clause already restricts to a
  -- false->true is_retired transition; this is the model safety net).
  IF NEW.model_id <> v_clients_model_id THEN
    RETURN NEW;
  END IF;

  UPDATE public.records f
  SET data = f.data || jsonb_build_object(
               'followup_status', 'cancelled',
               'cancel_reason', 'client_retired',
               'cancelled_at', to_char((now() AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD'),
               'cancelled_by_system', true,
               'cancelled_by_event_type', 'client_retired'
             )
  WHERE f.model_id = v_followups_model_id
    AND f.data->>'client_id' = NEW.id::text
    AND COALESCE(NULLIF(f.data->>'followup_status',''),'open') IN ('open','in_progress','scheduled');

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS records_cancel_followups_on_retire ON public.records;
CREATE TRIGGER records_cancel_followups_on_retire
  AFTER UPDATE ON public.records
  FOR EACH ROW
  WHEN ((OLD.data->>'is_retired') IS DISTINCT FROM 'true' AND (NEW.data->>'is_retired') = 'true')
  EXECUTE FUNCTION public.clients_cancel_followups_on_retire();

-- 2. One-time: cancel the open follow-ups already on the bulk-retired clients --
CREATE TABLE IF NOT EXISTS public._backup_followups_cancel_on_retire_20260908 AS
SELECT f.id, f.data, now() AS backed_up_at
FROM public.records f
WHERE f.model_id = (SELECT id FROM public.models WHERE name = 'followups')
  AND f.data->>'client_id' IN (
    SELECT id::text FROM public.records
    WHERE model_id = (SELECT id FROM public.models WHERE name = 'clients')
      AND (data->>'is_retired') = 'true'
  )
  AND COALESCE(NULLIF(f.data->>'followup_status',''),'open') IN ('open','in_progress','scheduled');

UPDATE public.records f
SET data = f.data || jsonb_build_object(
             'followup_status', 'cancelled',
             'cancel_reason', 'client_retired',
             'cancelled_at', to_char((now() AT TIME ZONE 'Asia/Riyadh')::date, 'YYYY-MM-DD'),
             'cancelled_by_system', true,
             'cancelled_by_event_type', 'client_retired'
           )
WHERE f.id IN (SELECT id FROM public._backup_followups_cancel_on_retire_20260908);
