-- Working-day-aware SLA: every task gets ONE full working day (24h), no more,
-- and the clock skips Fridays (the weekly off day). A scheduleless team can't
-- honour a 4h wall-clock deadline that lands overnight; a single working day,
-- Friday excluded, is the fair unit.
--
-- Also: (a) the late sweep no longer flags ORPHAN tasks (open workflow tasks
-- whose content was deleted) — that was manufacturing permanent "late" events;
-- (b) clears the existing orphan tasks + their discipline records (ريان's whole
-- pending pile was 9 orphan tasks on deleted content); (c) recomputes due_at for
-- every currently-open task under the new rule.
--
-- Everything is observe-mode still — no deduction is real until the desk toggles.

BEGIN;

-- 1. Add N hours of ELAPSED time to a start, skipping Fridays entirely (Riyadh).
--    Friday contributes zero budget, so "24h" = one full working day regardless
--    of when the task opened. Small loop (a 24h budget spans ~3 day-segments).
CREATE OR REPLACE FUNCTION public.mos_perf_due_after(p_start timestamptz, p_hours numeric)
RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_cursor    timestamptz := p_start;
  v_remaining numeric := GREATEST(COALESCE(p_hours, 0), 0);
  v_local     timestamp;
  v_day_end   timestamptz;
  v_seg       numeric;
  v_guard     int := 0;
BEGIN
  IF v_remaining <= 0 THEN RETURN p_start; END IF;
  WHILE v_remaining > 0 AND v_guard < 400 LOOP
    v_guard := v_guard + 1;
    v_local := v_cursor AT TIME ZONE 'Asia/Riyadh';
    -- End of the Riyadh calendar day containing the cursor, back in UTC.
    v_day_end := ((date_trunc('day', v_local) + interval '1 day') AT TIME ZONE 'Asia/Riyadh');
    IF EXTRACT(DOW FROM v_local) = 5 THEN
      -- Friday: jump to Saturday 00:00 Riyadh, consume nothing.
      v_cursor := v_day_end;
    ELSE
      v_seg := EXTRACT(EPOCH FROM (v_day_end - v_cursor)) / 3600.0;
      IF v_seg >= v_remaining THEN
        v_cursor := v_cursor + (v_remaining * interval '1 hour');
        v_remaining := 0;
      ELSE
        v_cursor := v_day_end;
        v_remaining := v_remaining - v_seg;
      END IF;
    END IF;
  END LOOP;
  RETURN v_cursor;
END $$;

REVOKE ALL ON FUNCTION public.mos_perf_due_after(timestamptz, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_perf_due_after(timestamptz, numeric) TO authenticated, service_role;

-- 2. Placement — re-emitted verbatim from 2026-08-28_02 with ONE change: the due
--    date is now a leave-adjusted, Friday-skipping ONE working day (capped 24h).
CREATE OR REPLACE FUNCTION public.mos_perf_place_open_task(p_task_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_task     public.workflow_role_tasks%ROWTYPE;
  v_bucket   text;
  v_cap      int;
  v_role_id  uuid;
  v_day      date;
  v_offset   int;
  v_pick     uuid;
  v_opened   timestamptz;
  v_sla      numeric;
  v_due      timestamptz;
  v_leave_h  numeric;
BEGIN
  SELECT * INTO v_task FROM public.workflow_role_tasks WHERE id = p_task_id;
  IF NOT FOUND OR v_task.status <> 'open' THEN RETURN; END IF;

  v_bucket := public.mos_perf_bucket_of(v_task.subject_id);
  UPDATE public.workflow_role_tasks SET bucket = v_bucket WHERE id = p_task_id;

  SELECT r.id INTO v_role_id FROM public.roles r WHERE r.key = 'mos_' || v_task.role_key;

  SELECT l.daily_new_tasks INTO v_cap
    FROM public.mos_role_load l
   WHERE l.role_id = v_role_id AND l.bucket = v_bucket;

  v_opened := now();

  IF v_cap IS NOT NULL AND v_cap > 0 THEN
    FOR v_offset IN 0..30 LOOP
      v_day := public.mos_perf_today() + v_offset;
      SELECT u.id INTO v_pick
        FROM public.users u
       WHERE u.is_active
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e
           WHERE e->>'role_id' = v_role_id::text)
         AND (SELECT count(*) FROM public.workflow_role_tasks t
               WHERE t.assignee_user_id = u.id AND t.bucket = v_bucket
                 AND t.role_key = v_task.role_key
                 AND (t.opened_at AT TIME ZONE 'Asia/Riyadh')::date = v_day) < v_cap
       ORDER BY
         (SELECT count(*) FROM public.workflow_role_tasks t
           WHERE t.assignee_user_id = u.id AND t.bucket = v_bucket
             AND t.role_key = v_task.role_key
             AND (t.opened_at AT TIME ZONE 'Asia/Riyadh')::date = v_day) ASC,
         (SELECT count(*) FROM public.workflow_role_tasks t
           WHERE t.assignee_user_id = u.id AND t.status = 'open') ASC,
         u.id ASC
       LIMIT 1;

      IF v_pick IS NOT NULL THEN
        IF v_offset > 0 THEN
          v_opened := (v_day::timestamp AT TIME ZONE 'Asia/Riyadh');
        END IF;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  -- One working day for every task (default 24h, never more), Friday skipped.
  v_sla := LEAST(COALESCE(public.mos_perf_sla_hours(v_task.role_key, v_bucket, v_task.step_key), 24), 24);
  v_due := public.mos_perf_due_after(v_opened, v_sla);
  -- Approved leave still pauses on top of the working-day clock.
  IF v_pick IS NOT NULL THEN
    SELECT COALESCE(sum(EXTRACT(EPOCH FROM (LEAST(l.end_at, v_due) - GREATEST(l.start_at, v_opened))) / 3600.0), 0)
      INTO v_leave_h
      FROM public.mos_leaves l
     WHERE l.user_id = v_pick AND l.status = 'approved'
       AND l.start_at < v_due AND l.end_at > v_opened;
    IF v_leave_h > 0 THEN v_due := v_due + (v_leave_h * interval '1 hour'); END IF;
  END IF;

  UPDATE public.workflow_role_tasks
     SET assignee_user_id = COALESCE(v_pick, assignee_user_id),
         opened_at        = v_opened,
         due_at           = COALESCE(v_due, due_at),
         updated_at       = now()
   WHERE id = p_task_id;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'mos_perf_place_open_task(%) failed: % %', p_task_id, SQLSTATE, SQLERRM;
END $$;

REVOKE ALL ON FUNCTION public.mos_perf_place_open_task(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_perf_place_open_task(uuid) TO authenticated, service_role;

-- 3. Late sweep — re-emitted with ONE change: the workflow branch ignores ORPHAN
--    tasks (subject content deleted). An orphan can never be worked or closed, so
--    flagging it late forever is a bug, not a signal.
CREATE OR REPLACE FUNCTION public.mos_perf_late_sweep()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_month   text := public.mos_perf_month_key();
  v_new     int := 0;
  v_actions int := 0;
  rec       record;
  v_event   uuid;
  v_ordinal int;
BEGIN
  FOR rec IN
    SELECT 'workflow' AS task_source, t.id, t.assignee_user_id AS user_id, t.subject_id AS content_id
      FROM public.workflow_role_tasks t
     WHERE t.status = 'open' AND NOT t.blocked AND NOT t.late_flag
       AND t.due_at IS NOT NULL AND t.due_at < now()
       AND t.assignee_user_id IS NOT NULL
       AND (t.subject_table <> 'mos_content'
            OR EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = t.subject_id))
    UNION ALL
    SELECT 'manual', m.id, m.assignee_user_id, m.content_id
      FROM public.mos_manual_tasks m
     WHERE m.status = 'open' AND NOT m.blocked AND NOT m.late_flag
       AND m.due_at IS NOT NULL AND m.due_at < now()
       AND m.assignee_user_id IS NOT NULL
  LOOP
    CONTINUE WHEN public.mos_perf_on_leave_now(rec.user_id);

    IF rec.task_source = 'workflow' THEN
      UPDATE public.workflow_role_tasks SET late_flag = true WHERE id = rec.id;
    ELSE
      UPDATE public.mos_manual_tasks SET late_flag = true WHERE id = rec.id;
    END IF;

    INSERT INTO public.mos_late_events (user_id, task_source, task_id, content_id, month_key)
    VALUES (rec.user_id, rec.task_source, rec.id, rec.content_id, v_month)
    ON CONFLICT (task_id) DO NOTHING
    RETURNING id INTO v_event;
    CONTINUE WHEN v_event IS NULL;
    v_new := v_new + 1;

    SELECT count(*) INTO v_ordinal FROM public.mos_late_events
     WHERE user_id = rec.user_id AND month_key = v_month;

    INSERT INTO public.mos_discipline_actions
      (user_id, month_key, ordinal, kind, amount_days, late_event_id)
    VALUES
      (rec.user_id, v_month, v_ordinal,
       CASE WHEN v_ordinal >= 4 THEN 'deduction' ELSE 'warning' END,
       CASE WHEN v_ordinal >= 4 THEN 1.0 ELSE NULL END,
       v_event)
    ON CONFLICT (late_event_id) DO NOTHING;
    v_actions := v_actions + 1;

    PERFORM public.notify_emit(
      'marketing', 'task_late', ARRAY[]::text[], ARRAY[rec.user_id],
      'مهمة متأخرة', 'A task passed its deadline',
      'مهمة تجاوزت موعدها ولا تزال مفتوحة — أنجزها بأسرع وقت.', 'An open task passed its due date.',
      CASE WHEN rec.content_id IS NOT NULL THEN '/m/content/' || rec.content_id ELSE '/m/my-work' END,
      NULL);
  END LOOP;

  RETURN jsonb_build_object('month', v_month, 'new_late_events', v_new, 'actions', v_actions);
END $$;

REVOKE ALL ON FUNCTION public.mos_perf_late_sweep() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mos_perf_late_sweep() FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.mos_perf_late_sweep() TO service_role;

-- 4. Uniform config: every SLA row = one working day (24h). The placement caps
--    at 24 regardless, so this just makes the Settings grid read the truth.
UPDATE public.mos_role_sla SET sla_hours = 24, updated_at = now() WHERE sla_hours <> 24;

-- 5. Clear ORPHAN open workflow tasks (content deleted) + their discipline
--    records. This is ريان's entire pending pile (9 orphan tasks). Only pending/
--    disputed actions are removed — an approved decision is never deleted.
DELETE FROM public.mos_discipline_actions da
 USING public.mos_late_events le
 WHERE da.late_event_id = le.id
   AND da.status IN ('pending', 'disputed')
   AND le.task_source = 'workflow'
   AND le.task_id IN (
     SELECT t.id FROM public.workflow_role_tasks t
      WHERE t.status = 'open' AND t.subject_table = 'mos_content'
        AND NOT EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = t.subject_id));

DELETE FROM public.mos_late_events le
 WHERE le.task_source = 'workflow'
   AND le.task_id IN (
     SELECT t.id FROM public.workflow_role_tasks t
      WHERE t.status = 'open' AND t.subject_table = 'mos_content'
        AND NOT EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = t.subject_id));

UPDATE public.workflow_role_tasks t
   SET status = 'skipped', late_flag = false, updated_at = now()
 WHERE t.status = 'open' AND t.subject_table = 'mos_content'
   AND NOT EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = t.subject_id);

-- 6. Recompute due_at for every remaining OPEN workflow task under the new rule
--    (one working day from when it opened, Friday-skipped), so existing tasks
--    stop carrying the old 4h/8h wall-clock deadline.
UPDATE public.workflow_role_tasks t
   SET due_at = public.mos_perf_due_after(t.opened_at, 24), updated_at = now()
 WHERE t.status = 'open' AND t.opened_at IS NOT NULL;

COMMIT;
