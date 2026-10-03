-- Heal follow-ups left open by the on_due sweeper's 1,000-row truncation (2026-10-03).
--
-- WHAT WENT WRONG
-- The "WhatsApp No-Response Escalation" workflow (918b2540…) does two things
-- when a waiting WhatsApp task times out: (1) close that task — call_result
-- no_response, whatsapp_state no_response_expired, followup_status completed —
-- and (2) create the next task. The sweeper found the task to close by loading
-- the whole followups model in ONE PostgREST request and searching the result.
-- PostgREST silently returns at most 1,000 rows; followups has ~3,755. So step
-- (1) was skipped with `no_matching_record` on most runs while step (2) still
-- ran. Measured live before this migration: the old query returned exactly
-- 1,000 rows and contained NONE of the 99 stuck tasks.
--
-- The code fix is in api/_lib/workflowRecordLoad.ts (read the target by id).
-- This migration repairs the rows the bug already left behind. Apply it AFTER
-- the code fix is deployed, or the sweeper keeps producing new ones.
--
-- PART A — close the stuck WhatsApp tasks (98 rows when written)
--   A waiting attempt-2 WhatsApp task whose 5-day escalation has ALREADY fired
--   (fired_at is later than the last send) and already produced its booking
--   call. It gets exactly the three values the workflow's own update would
--   have written. Left open, the next rep message re-arms it for +24h and the
--   sweep mints ANOTHER booking call (record 1877e218 has four).
--   Deliberately NOT healed here: a task with no 5-day booking call at all
--   (one row, 1b87f86f — its sweep claimed it on 2026-09-14 and never ran the
--   workflow). Closing it by hand would leave that client with no task; it is
--   re-fired through the fixed sweeper instead, which closes it AND creates
--   the call it never got.
--
-- PART B — cancel duplicate open 5-day booking calls (5 rows when written)
--   Where one client has more than one open booking call with
--   escalation_reason = whatsapp_no_response_5d, keep the newest and cancel the
--   rest with cancel_reason = 'duplicate_escalation_heal'. All ten rows were
--   checked: status open, no notes, no outcome — nothing a rep typed is lost.
--
-- WHY wassell.system_write IS SET (decision, with the evidence)
--   `followups` is server-enrolled, so every update normally queues a
--   workflow job and the runner evaluates the six update-workflows on it. For
--   these writes that evaluation is a guaranteed no-op: none of the six has a
--   branch for call_result = no_response on a WhatsApp task or for a cancelled
--   booking call, and none has an OTHERWISE branch. Measured on the 78 tasks
--   the sweeper DID close correctly: 468 runs, 468 `skipped`, 0 actions.
--   Letting them fire would add ~100 jobs and ~600 "skipped" rows to the
--   Workflow Logs and change nothing. The flag is transaction-local and is
--   read only by tg_records_capture_workflow_event and the translation
--   capture path; the trigger that matters here — records_touch_client_on_
--   activity, which recomputes each client's next action — does NOT read it
--   and still runs.
--
-- SAFE TO RE-RUN: every UPDATE re-checks its own condition, so a second run
-- (or a fresh database with no followups model) changes nothing.
-- ROLLBACK: UPDATE public.records r SET data = b.data
--             FROM public._backup_followups_sweeper_heal_20261003 b WHERE r.id = b.id;

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_followups_sweeper_heal_20261003 (
  id           uuid PRIMARY KEY,
  heal_part    text        NOT NULL,
  data         jsonb       NOT NULL,
  version      integer,
  updated_at   timestamptz,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public._backup_followups_sweeper_heal_20261003 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._backup_followups_sweeper_heal_20261003 FROM anon, authenticated;

DO $heal$
DECLARE
  v_model     uuid;
  v_now_iso   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_stuck     uuid[];
  v_dupes     uuid[];
  v_closed    int := 0;
  v_cancelled int := 0;
  v_left      int := 0;
BEGIN
  SELECT id INTO v_model FROM public.models WHERE name = 'followups' LIMIT 1;
  IF v_model IS NULL THEN
    RAISE NOTICE 'followups_sweeper_heal: no followups model — nothing to heal';
    RETURN;
  END IF;

  PERFORM set_config('wassell.system_write', 'sweeper_heal', true);

  -- ── PART A ──────────────────────────────────────────────────────────────
  SELECT COALESCE(array_agg(w.id), '{}') INTO v_stuck
  FROM public.records w
  WHERE w.model_id = v_model
    AND ( (jsonb_typeof(w.data->'followup_type') = 'array' AND w.data->'followup_type' ? 'whatsapp_follow_up')
       OR w.data->>'followup_type' = 'whatsapp_follow_up' )
    AND w.data->>'followup_status' = 'in_progress'
    AND w.data->>'whatsapp_state'  = 'message_sent_waiting_response'
    AND public.try_numeric(w.data->>'whatsapp_attempt_number') = 2
    AND public.try_timestamptz(w.data->>'fired_at') > public.try_timestamptz(w.data->>'sent_at')
    AND EXISTS (
      SELECT 1 FROM public.records c
      WHERE c.model_id = v_model
        AND c.data->>'escalation_reason'    = 'whatsapp_no_response_5d'
        AND c.data->>'previous_followup_id' = w.id::text);

  INSERT INTO public._backup_followups_sweeper_heal_20261003 (id, heal_part, data, version, updated_at)
  SELECT r.id, 'A_close_stuck_whatsapp_task', r.data, r.version, r.updated_at
  FROM public.records r WHERE r.id = ANY (v_stuck)
  ON CONFLICT (id) DO NOTHING;

  -- The state is re-checked on the row as it is NOW: a rep message landing
  -- between the SELECT above and this UPDATE re-arms the task (fired_at is
  -- removed), and a re-armed task must be left for the sweeper.
  UPDATE public.records r
  SET data = r.data || jsonb_build_object(
        'call_result',     'no_response',
        'whatsapp_state',  'no_response_expired',
        'followup_status', 'completed',
        'heal_source',     'on_due_pagination_heal_2026-10-03')
  WHERE r.id = ANY (v_stuck)
    AND r.data->>'followup_status' = 'in_progress'
    AND r.data->>'whatsapp_state'  = 'message_sent_waiting_response'
    AND r.data ? 'fired_at';
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  -- ── PART B ──────────────────────────────────────────────────────────────
  SELECT COALESCE(array_agg(s.id), '{}') INTO v_dupes
  FROM (
    SELECT r.id,
           row_number() OVER (PARTITION BY r.data->>'client_id'
                              ORDER BY r.created_at DESC, r.id DESC) AS rn
    FROM public.records r
    WHERE r.model_id = v_model
      AND r.data->>'escalation_reason' = 'whatsapp_no_response_5d'
      AND ( (jsonb_typeof(r.data->'followup_type') = 'array' AND r.data->'followup_type' ? 'appointment_booking_call')
         OR r.data->>'followup_type' = 'appointment_booking_call' )
      AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress')
      AND NULLIF(r.data->>'client_id', '') IS NOT NULL
  ) s
  WHERE s.rn > 1;

  INSERT INTO public._backup_followups_sweeper_heal_20261003 (id, heal_part, data, version, updated_at)
  SELECT r.id, 'B_cancel_duplicate_5d_booking_call', r.data, r.version, r.updated_at
  FROM public.records r WHERE r.id = ANY (v_dupes)
  ON CONFLICT (id) DO NOTHING;

  -- Same shape the system's own cancellations write (reconcile_outbound_whatsapp).
  UPDATE public.records r
  SET data = r.data || jsonb_build_object(
        'followup_status',     'cancelled',
        'cancel_reason',       'duplicate_escalation_heal',
        'cancelled_at',        v_now_iso,
        'cancelled_by_system', true)
  WHERE r.id = ANY (v_dupes)
    AND COALESCE(NULLIF(r.data->>'followup_status', ''), 'open') IN ('open', 'in_progress');
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  PERFORM set_config('wassell.system_write', '', true);

  -- Nothing that matched Part A may still be open. Zero rows on a fresh
  -- database, so this cannot block a replay.
  SELECT count(*) INTO v_left
  FROM public.records r
  WHERE r.id = ANY (v_stuck)
    AND r.data->>'followup_status' = 'in_progress'
    AND r.data ? 'fired_at';
  IF v_left > 0 THEN
    RAISE EXCEPTION 'FOLLOWUPS_SWEEPER_HEAL_INCOMPLETE — % stuck task(s) still open', v_left;
  END IF;

  RAISE NOTICE 'followups_sweeper_heal: closed % stuck WhatsApp task(s) of % matched; cancelled % duplicate booking call(s) of % matched',
    v_closed, COALESCE(array_length(v_stuck, 1), 0), v_cancelled, COALESCE(array_length(v_dupes, 1), 0);
END
$heal$;

COMMIT;
