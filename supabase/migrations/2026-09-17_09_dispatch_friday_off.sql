-- ============================================================================
-- Friday is a day off for the task system too. 2026-09-17.
--
-- Operator: "Friday is always a vacation. There is no work done on Friday."
-- The month PLANNER already knew (mos_settings.planning.weekend_days = [5],
-- mos_is_working_day), but the dispatcher built earlier today counted every
-- hour: it handed work out on Friday and a 24-hour allowance ran through it.
--
--   · mos_work_due_at(from, hours) — adds an allowance counting ONLY hours of
--     working days (Riyadh), so a Thursday-evening hand-out is due Saturday
--     evening, not Friday. Weekend and holidays come from mos_is_working_day.
--   · mos_task_dispatch — hands nothing out on a non-working day (the task waits
--     with waiting_reason 'day_off') and dates the deadline with mos_work_due_at.
--   · mos_plan_start_due — starts no new work on a non-working day.
--   · mos_task_rules_audit — R3 expects the working-hours deadline; R5/R6 do not
--     flag waiting or unstarted work on a day off.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_work_due_at(p_from timestamptz, p_hours numeric)
RETURNS timestamptz
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_left   interval := p_hours * interval '1 hour';
  v_cursor timestamptz := p_from;
  v_day    date;
  v_eod    timestamptz;
  i        int := 0;
BEGIN
  IF p_from IS NULL OR p_hours IS NULL THEN RETURN NULL; END IF;
  WHILE i < 400 LOOP
    i := i + 1;
    v_day := (v_cursor AT TIME ZONE 'Asia/Riyadh')::date;
    v_eod := ((v_day + 1)::timestamp AT TIME ZONE 'Asia/Riyadh');
    IF public.mos_is_working_day(v_day) THEN
      IF v_cursor + v_left <= v_eod THEN
        RETURN v_cursor + v_left;
      END IF;
      v_left := v_left - (v_eod - v_cursor);
    END IF;
    v_cursor := v_eod;
  END LOOP;
  RAISE EXCEPTION 'MOS:WORK_DUE_UNBOUNDED no working day within 400 days of %', p_from
    USING ERRCODE = 'data_exception';
END $$;
REVOKE ALL ON FUNCTION public.mos_work_due_at(timestamptz, numeric) FROM PUBLIC, anon, authenticated;

DO $migrate$
DECLARE
  v_def text;
  v_old text;
BEGIN
  -- dispatcher: no hand-out on a day off; working-hours deadline
  v_def := pg_get_functiondef('public.mos_task_dispatch(uuid, boolean)'::regprocedure);
  v_old := E'  SELECT h.uid INTO v_pick\n';
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING dispatch pick'; END IF;
  v_def := replace(v_def, v_old,
    E'  IF NOT public.mos_is_working_day((v_now AT TIME ZONE ''Asia/Riyadh'')::date) THEN\n'
    || E'    UPDATE public.workflow_role_tasks\n'
    || E'       SET bucket = v_bucket, units = v_units, assignee_user_id = NULL, assigned_at = NULL,\n'
    || E'           due_at = NULL, waiting_since = COALESCE(waiting_since, v_now), waiting_reason = ''day_off''\n'
    || E'     WHERE id = p_task_id;\n'
    || E'    RETURN ''waiting'';\n'
    || E'  END IF;\n\n'
    || v_old);
  v_old := 'v_due := v_now + v_allow * interval ''1 hour'';';
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING dispatch due'; END IF;
  v_def := replace(v_def, v_old, 'v_due := public.mos_work_due_at(v_now, v_allow);');
  EXECUTE v_def;

  -- starts: none on a day off
  v_def := pg_get_functiondef('public.mos_plan_start_due()'::regprocedure);
  v_old := E'  -- (1) New starts, rows and loose items together, earliest publish first.\n';
  IF position(v_old IN v_def) = 0 THEN
    v_old := E'  v_sweep := public.mos_dispatch_sweep();\n';
    IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING start_due sweep'; END IF;
  END IF;
  v_def := replace(v_def, E'  FOR r IN\n    SELECT q.st, q.id, q.ver\n',
    E'  FOR r IN\n    SELECT q.st, q.id, q.ver\n');
  v_old := E'     WHERE NOT public.mos_subject_inactive(q.st, q.id)\n';
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING start_due filter'; END IF;
  v_def := replace(v_def, v_old,
    E'     WHERE NOT public.mos_subject_inactive(q.st, q.id)\n'
    || E'       AND public.mos_is_working_day(v_today)\n');
  EXECUTE v_def;

  -- audit: the same deadline rule; no flags on a day off
  v_def := pg_get_functiondef('public.mos_task_rules_audit()'::regprocedure);
  v_old := 'COALESCE(t.assigned_at, t.opened_at) + sr.allowance_hours * interval ''1 hour''';
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING audit due'; END IF;
  v_def := replace(v_def, v_old, 'public.mos_work_due_at(COALESCE(t.assigned_at, t.opened_at), sr.allowance_hours)');
  v_old := E'   WHERE t.status = ''open'' AND t.assignee_user_id IS NULL\n';
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING audit R5'; END IF;
  v_def := replace(v_def, v_old, v_old || E'     AND public.mos_is_working_day(public.mos_perf_today())\n');
  v_old := E'   WHERE NOT public.mos_subject_inactive(p.st, p.id)\n';
  IF position(v_old IN v_def) = 0 THEN RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING audit R6'; END IF;
  v_def := replace(v_def, v_old, v_old || E'     AND public.mos_is_working_day(public.mos_perf_today())\n');
  EXECUTE v_def;
END $migrate$;

-- proofs, in Riyadh time (Friday 2026-09-18 is a day off)
DO $$
DECLARE v timestamptz;
BEGIN
  -- Thursday 20:00 + 24h → Saturday 20:00 (Friday skipped)
  v := public.mos_work_due_at(('2026-09-17 20:00'::timestamp AT TIME ZONE 'Asia/Riyadh'), 24);
  IF v <> ('2026-09-19 20:00'::timestamp AT TIME ZONE 'Asia/Riyadh') THEN
    RAISE EXCEPTION 'MOS:WORK_DUE_PROOF_1 got %', v AT TIME ZONE 'Asia/Riyadh';
  END IF;
  -- Friday 10:00 + 12h → Saturday 12:00 (the clock starts Saturday 00:00)
  v := public.mos_work_due_at(('2026-09-18 10:00'::timestamp AT TIME ZONE 'Asia/Riyadh'), 12);
  IF v <> ('2026-09-19 12:00'::timestamp AT TIME ZONE 'Asia/Riyadh') THEN
    RAISE EXCEPTION 'MOS:WORK_DUE_PROOF_2 got %', v AT TIME ZONE 'Asia/Riyadh';
  END IF;
  -- Sunday 09:00 + 24h → Monday 09:00 (no day off in between)
  v := public.mos_work_due_at(('2026-09-20 09:00'::timestamp AT TIME ZONE 'Asia/Riyadh'), 24);
  IF v <> ('2026-09-21 09:00'::timestamp AT TIME ZONE 'Asia/Riyadh') THEN
    RAISE EXCEPTION 'MOS:WORK_DUE_PROOF_3 got %', v AT TIME ZONE 'Asia/Riyadh';
  END IF;
  IF pg_get_functiondef('public.mos_task_dispatch(uuid, boolean)'::regprocedure) NOT LIKE '%day_off%'
     OR pg_get_functiondef('public.mos_task_dispatch(uuid, boolean)'::regprocedure) NOT LIKE '%mos_work_due_at%'
     OR pg_get_functiondef('public.mos_plan_start_due()'::regprocedure) NOT LIKE '%mos_is_working_day(v_today)%' THEN
    RAISE EXCEPTION 'MOS:FRIDAY_REWIRE_FAILED';
  END IF;
END $$;

COMMIT;
