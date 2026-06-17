-- ============================================================================
-- Late-arriving call recordings auto-link to their follow-up.
--
-- The Follow-up Workspace auto-links the most recent matching outbound call as
-- `completed_by_call_id` — but only for a call that ALREADY EXISTS while the rep
-- has the follow-up open. When a rep completes the follow-up before Hatif
-- delivers the recording, `completed_by_call_id` is saved empty and the late
-- `phone_calls` row (created by api/webhook/hatif-call.ts) is linked only to the
-- CLIENT (`client_link`), never to the follow-up. Nothing reconciled the two.
--
-- This trigger closes that gap from the DB side, so the order of "rep saves" vs
-- "recording arrives" no longer matters and every call-creation path is covered
-- (webhook, manual entry, backfill):
--
--   BEFORE INSERT/UPDATE on a phone_calls row → if it's an OUTBOUND call with a
--   client and no follow-up link yet, find that client's CLOSEST completed
--   call-type follow-up whose completion time is within 2h of the call and that
--   has no call attached, then stamp BOTH sides:
--     • the call's   `linked_followup_id`   (set inline on NEW — no self-write)
--     • the follow-up's `completed_by_call_id` (via UPDATE)
--
-- Conservative by design (outbound + same client + 2h window + closest +
-- only-if-empty + excludes WhatsApp follow-ups) so a call never lands on a
-- chat-completed task or an already-linked follow-up. Complements — never
-- fights — the workspace auto-link: a follow-up that already has a call is
-- excluded, and a call that already has `linked_followup_id` returns early.
--
-- SECURITY DEFINER so it reads across records and updates the follow-up
-- regardless of the call-writer's RLS. phone_calls + followups are UNFROZEN
-- (JSONB in records); if either is frozen, move this to the frozen write path
-- (same caveat as the all_projects rollups + the client next-action trigger).
--
-- Idempotent. Safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._sales_phone_calls_model_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT id FROM public.models WHERE name = 'phone_calls' LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.tg_records_link_call_to_followup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_calls     uuid := public._sales_phone_calls_model_id();
  v_followups uuid := public._sales_followups_model_id();
  v_client    text;
  v_calltime  timestamptz;
  v_match     uuid;
BEGIN
  -- Only outbound phone_calls that have a client and aren't linked yet.
  IF NEW.model_id IS DISTINCT FROM v_calls THEN RETURN NEW; END IF;
  IF NEW.data->>'direction' IS DISTINCT FROM 'outbound' THEN RETURN NEW; END IF;
  IF nullif(NEW.data->>'linked_followup_id', '') IS NOT NULL THEN RETURN NEW; END IF;

  v_client := nullif(NEW.data->>'client_link', '');
  IF v_client IS NULL OR v_client !~* '^[0-9a-f-]{36}$' THEN RETURN NEW; END IF;

  -- Reference time = the call's own timestamp, else "now" (the recording just
  -- arrived) so a call with no call_time can still window-match.
  v_calltime := COALESCE(public.try_timestamptz(NEW.data->>'call_time'), now());

  -- Closest completed CALL-channel follow-up for this client, within 2h of the
  -- call, that has no call attached. WhatsApp follow-ups are excluded so a call
  -- never lands on a chat-completed task.
  SELECT f.id INTO v_match
  FROM public.records f
  WHERE f.model_id = v_followups
    AND public._followup_client_id_of(f.data) = v_client
    AND f.data->>'followup_status' = 'completed'
    AND nullif(f.data->>'completed_by_call_id', '') IS NULL
    AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') IS DISTINCT FROM 'whatsapp_follow_up'
    AND public.try_timestamptz(f.data->>'actual_datetime') IS NOT NULL
    AND abs(extract(epoch FROM (public.try_timestamptz(f.data->>'actual_datetime') - v_calltime))) <= 7200
  ORDER BY abs(extract(epoch FROM (public.try_timestamptz(f.data->>'actual_datetime') - v_calltime))) ASC
  LIMIT 1;

  IF v_match IS NULL THEN RETURN NEW; END IF;

  -- Bidirectional link. The call's side is set inline on NEW (no self-update →
  -- no trigger reentry); the follow-up's side is stamped via UPDATE.
  NEW.data := NEW.data || jsonb_build_object('linked_followup_id', v_match::text);

  UPDATE public.records
  SET data = data || jsonb_build_object('completed_by_call_id', NEW.id::text)
  WHERE id = v_match AND model_id = v_followups;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS records_link_call_to_followup ON public.records;
CREATE TRIGGER records_link_call_to_followup
BEFORE INSERT OR UPDATE ON public.records
FOR EACH ROW EXECUTE FUNCTION public.tg_records_link_call_to_followup();
