-- ============================================================================
-- Tighten the call → follow-up evidence window from 2h to 15 minutes, and
-- unlink the stale pairs that the unbounded client-side auto-attach created.
--
-- WHY
--   Two code paths decide which call completed a follow-up, and they disagreed:
--
--     • src/pages/Followups/components/EvidencePicker.tsx auto-attached the
--       client's MOST RECENT outbound call with no time bound whatsoever.
--     • This trigger (for recordings that arrive after the rep completes the
--       task) used a 2-hour window.
--
--   Measured against wassell-prod on 2026-07-30, over the 400 completed
--   follow-ups carrying a linked call:
--
--     within 15 min ......... 373  (93.25%)   median delta 0.6 min
--     15-60 min .............   3
--     1-24 h ................   4
--     over 24 h .............  20   worst: 125,009 min ≈ 87 days
--
--   Every link beyond 15 minutes is wrong — all 27 are `appointment_booking_call`
--   rows where the rep completed a task for a client who happened to have an old
--   call on file. 15 minutes is generous against a 0.6-minute median: dial, talk,
--   write notes, hit Complete still fits comfortably inside it.
--
--   This matters more than tidiness: the AI call-result pipeline classifies the
--   linked call's transcript. Pointed at an 87-day-old conversation it would
--   confidently propose an outcome from the wrong call, and show the rep the
--   wrong recording as proof. Refusing to link is the correct answer when
--   nothing is close enough.
--
-- WHAT THIS DOES
--   1. Replaces tg_records_link_call_to_followup with a 900-second window.
--      Everything else about the trigger is unchanged (outbound + same client +
--      closest + only-if-both-empty + excludes WhatsApp follow-ups).
--   2. Snapshots then clears BOTH sides of every out-of-window link.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   It never touches `call_result`, `followup_status`, or any other outcome
--   field. The rep's recorded outcome stands; only the wrong EVIDENCE pointer is
--   removed. Un-completing a follow-up here would re-fire the sales workflows
--   and move real clients' pipeline stages.
--
-- Keep the 900 below in sync with CALL_MATCH_WINDOW_MINUTES in
-- src/lib/salesProcess/callMatch.ts — that constant is the client-side half of
-- this same rule.
--
-- Idempotent. Safe to re-run: the snapshot is written once, and a second pass
-- finds no out-of-window links left to clear.
-- ============================================================================

BEGIN;

-- ── 1. The window ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_records_link_call_to_followup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  v_calls     uuid := public._sales_phone_calls_model_id();
  v_followups uuid := public._sales_followups_model_id();
  -- Half-width of the evidence window, in seconds. 15 min — see the migration
  -- header for the production measurement behind this number.
  v_window    int  := 900;
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

  -- Closest completed CALL-channel follow-up for this client, within the window,
  -- that has no call attached. WhatsApp follow-ups are excluded so a call never
  -- lands on a chat-completed task.
  SELECT f.id INTO v_match
  FROM public.records f
  WHERE f.model_id = v_followups
    AND public._followup_client_id_of(f.data) = v_client
    AND f.data->>'followup_status' = 'completed'
    AND nullif(f.data->>'completed_by_call_id', '') IS NULL
    AND COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') IS DISTINCT FROM 'whatsapp_follow_up'
    AND public.try_timestamptz(f.data->>'actual_datetime') IS NOT NULL
    AND abs(extract(epoch FROM (public.try_timestamptz(f.data->>'actual_datetime') - v_calltime))) <= v_window
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

-- ── 2. Repair the existing bad links ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public._backup_stale_call_links_20260730 (
  followup_id     uuid PRIMARY KEY,
  call_id         uuid NOT NULL,
  actual_datetime timestamptz,
  call_time       timestamptz,
  delta_minutes   numeric,
  call_result     text,
  followup_type   text,
  captured_at     timestamptz NOT NULL DEFAULT now()
);

-- Identify every follow-up whose linked call sits outside the window, and record
-- it. The call's timestamp comes from the phone_calls record (what the app
-- reads), falling back to call_logs.creation_time for rows written before the
-- record carried it.
--
-- The snapshot table doubles as the work list for the two UPDATEs below, so this
-- needs no temp table and behaves identically whether or not the runner wraps the
-- script in an explicit transaction. Re-running is a no-op: ON CONFLICT keeps the
-- original capture, and the UPDATEs re-check current state before clearing.
INSERT INTO public._backup_stale_call_links_20260730
  (followup_id, call_id, actual_datetime, call_time, delta_minutes, call_result, followup_type)
WITH linked AS (
  SELECT
    f.id                                                   AS followup_id,
    nullif(f.data->>'completed_by_call_id', '')::uuid      AS call_id,
    public.try_timestamptz(f.data->>'actual_datetime')     AS actual_dt,
    f.data->>'call_result'                                 AS call_result,
    COALESCE(f.data->'followup_type'->>0, f.data->>'followup_type') AS followup_type
  FROM public.records f
  WHERE f.model_id = public._sales_followups_model_id()
    AND nullif(f.data->>'completed_by_call_id', '') ~* '^[0-9a-f-]{36}$'
),
resolved AS (
  SELECT
    l.*,
    COALESCE(public.try_timestamptz(c.data->>'call_time'), cl.creation_time) AS call_time
  FROM linked l
  LEFT JOIN public.records   c  ON c.id = l.call_id
                               AND c.model_id = public._sales_phone_calls_model_id()
  LEFT JOIN public.call_logs cl ON cl.id = l.call_id
)
SELECT
  followup_id, call_id, actual_dt, call_time,
  round((extract(epoch FROM (actual_dt - call_time)) / 60)::numeric, 1),
  call_result, followup_type
FROM resolved
WHERE actual_dt  IS NOT NULL
  AND call_time  IS NOT NULL
  AND abs(extract(epoch FROM (actual_dt - call_time))) > 900
ON CONFLICT (followup_id) DO NOTHING;

-- Follow-up side FIRST. Clearing this makes the follow-up a link candidate again,
-- but it is by definition outside the window, so the trigger below cannot re-pair
-- it with the same call.
UPDATE public.records f
SET data = f.data - 'completed_by_call_id'
FROM public._backup_stale_call_links_20260730 s
WHERE f.id = s.followup_id
  AND nullif(f.data->>'completed_by_call_id', '') = s.call_id::text;

-- Call side. This UPDATE re-fires tg_records_link_call_to_followup with
-- linked_followup_id now empty; the 15-minute window is what stops it from
-- re-creating the link we just removed. If a genuinely close follow-up exists,
-- re-linking to THAT one is the correct outcome.
UPDATE public.records c
SET data = c.data - 'linked_followup_id'
FROM public._backup_stale_call_links_20260730 s
WHERE c.id = s.call_id
  AND c.model_id = public._sales_phone_calls_model_id()
  AND nullif(c.data->>'linked_followup_id', '') = s.followup_id::text;

COMMIT;
