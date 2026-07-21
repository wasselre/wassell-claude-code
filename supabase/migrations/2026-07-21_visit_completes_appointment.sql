-- ============================================================================
-- Visit completes its appointment + no-show recovery dedup guard (2026-07-21)
--
-- Bug being fixed (sales-process improvement plan, Workstream D):
--  * Recording a visit never touched the appointment. The appointment stayed
--    'scheduled'/'confirmed', so 24h later the "Auto-close No-Show" on_due
--    workflow flipped an ATTENDED appointment to no_show, stamped the client
--    لم يحضر الموعد, and spawned a recovery call — a false no-show.
--  * Visits carry no appointment reference at all (client_id/project_id only),
--    so the match is client + nearest appointment around the visit time.
--
-- Guard: prevents a second no_show_recovery_call follow-up for the same
-- appointment (the auto-close path creates the task AND flips status; if the
-- status flip ever ALSO runs the "No-Show Recovery" update workflow — e.g.
-- engine chaining — the second create is silently converged at the DB layer).
-- DB triggers, not workflows: cover every write path incl. imports/server.
-- ============================================================================

-- ─── 1. Visit INSERT → complete the matching appointment ────────────────────
CREATE OR REPLACE FUNCTION public.tg_records_visit_completes_appointment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_visits uuid;
  v_appts  uuid;
  v_client text;
  v_visit_at timestamptz;
  v_match uuid;
BEGIN
  SELECT id INTO v_visits FROM models WHERE name = 'visits' LIMIT 1;
  IF NEW.model_id IS DISTINCT FROM v_visits THEN RETURN NEW; END IF;

  v_client := NULLIF(NEW.data->>'client_id', '');
  IF v_client IS NULL OR v_client !~* '^[0-9a-f-]{36}$' THEN RETURN NEW; END IF;

  SELECT id INTO v_appts FROM models WHERE name = 'appointments' LIMIT 1;
  IF v_appts IS NULL THEN RETURN NEW; END IF;

  -- visits' datetime field is scheduled_datetime (verified against live schema)
  v_visit_at := COALESCE(
    public.try_timestamptz(NEW.data->>'scheduled_datetime'),
    now());

  -- Nearest not-yet-terminal appointment for this client within ±3 days of
  -- the visit. Terminal statuses (completed/cancelled/no_show) are left alone.
  SELECT a.id INTO v_match
  FROM records a
  WHERE a.model_id = v_appts
    AND a.data->>'client_id' = v_client
    AND COALESCE(NULLIF(a.data->>'appointment_status', ''), 'scheduled')
        IN ('scheduled', 'confirmed', 'rescheduled')
    AND public.try_timestamptz(a.data->>'appointment_date') IS NOT NULL
    AND abs(extract(epoch FROM (public.try_timestamptz(a.data->>'appointment_date') - v_visit_at))) <= 259200
  ORDER BY abs(extract(epoch FROM (public.try_timestamptz(a.data->>'appointment_date') - v_visit_at))) ASC
  LIMIT 1;

  IF v_match IS NULL THEN RETURN NEW; END IF;

  UPDATE records
  SET data = data || jsonb_build_object(
        'appointment_status', 'completed',
        'completed_by_visit_id', NEW.id::text)
  WHERE id = v_match;

  -- Back-link the visit to its appointment (visits had no reference at all).
  NEW.data := NEW.data || jsonb_build_object('appointment_id', v_match::text);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS records_visit_completes_appointment ON public.records;
CREATE TRIGGER records_visit_completes_appointment
  BEFORE INSERT ON public.records
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_records_visit_completes_appointment();

-- ─── 2. Dedup guard: one recovery task per appointment ──────────────────────
CREATE OR REPLACE FUNCTION public.tg_records_dedup_noshow_recovery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_followups uuid;
  v_appt text;
BEGIN
  SELECT id INTO v_followups FROM models WHERE name = 'followups' LIMIT 1;
  IF NEW.model_id IS DISTINCT FROM v_followups THEN RETURN NEW; END IF;

  IF NOT ( (jsonb_typeof(NEW.data->'followup_type') = 'array' AND NEW.data->'followup_type' ? 'no_show_recovery_call')
        OR NEW.data->>'followup_type' = 'no_show_recovery_call' ) THEN
    RETURN NEW;
  END IF;

  v_appt := NULLIF(NEW.data->>'appointment_id', '');
  IF v_appt IS NULL THEN RETURN NEW; END IF;

  -- A recovery task for this appointment already exists (any status) → skip
  -- the insert silently. Idempotent convergence, not an error: the two create
  -- paths (auto-close action + status-flip workflow) intend the same task.
  IF EXISTS (
    SELECT 1 FROM records r
    WHERE r.model_id = v_followups
      AND r.data->>'appointment_id' = v_appt
      AND ( (jsonb_typeof(r.data->'followup_type') = 'array' AND r.data->'followup_type' ? 'no_show_recovery_call')
         OR r.data->>'followup_type' = 'no_show_recovery_call' )
  ) THEN
    RETURN NULL;  -- BEFORE INSERT: returning NULL skips the row
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS records_dedup_noshow_recovery ON public.records;
CREATE TRIGGER records_dedup_noshow_recovery
  BEFORE INSERT ON public.records
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_records_dedup_noshow_recovery();
