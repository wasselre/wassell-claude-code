-- Marketing performance & load system — ENGINE (functions + triggers + RPCs).
-- ============================================================================
-- Companion to 2026-08-28_01_mos_perf_core.sql. Everything behavioral:
--   • capacity placement (assignee + intake day) on every task open
--   • SLA due dates (mos_role_sla, leave-adjusted)
--   • on-time XP trigger (+2 when a task closes before its due)
--   • the late sweep (late_flag → mos_late_events → discipline actions)
--   • rating → XP, reward claims, discipline decisions, leaves, block/unblock
--   • KPI evaluation off mos_perf_paid_monthly
--
-- workflow_advance_role_path and workflow_role_path_start are re-emitted
-- VERBATIM from the live definitions with exactly ONE addition each: a
-- PERFORM mos_perf_place_open_task(...) after the INSERT of the new open task.
-- Placement NEVER breaks task flow: any internal error is logged as a WARNING
-- and the task opens with the legacy due_days date (documented, loud in DB
-- logs — not a silent catch of the business write itself).
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Small helpers
-- ────────────────────────────────────────────────────────────────────────────

-- Riyadh calendar day / month key — the operator's clock, not UTC.
CREATE OR REPLACE FUNCTION public.mos_perf_today()
RETURNS date LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT (now() AT TIME ZONE 'Asia/Riyadh')::date;
$$;

CREATE OR REPLACE FUNCTION public.mos_perf_month_key()
RETURNS text LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM');
$$;

-- A user's currently-approved leave covering `now()` — the late sweep skips them.
CREATE OR REPLACE FUNCTION public.mos_perf_on_leave_now(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.mos_leaves
    WHERE user_id = p_user_id AND status = 'approved'
      AND start_at <= now() AND end_at >= now());
$$;

-- The load bucket for a content item: mos_load_buckets, else key heuristic.
CREATE OR REPLACE FUNCTION public.mos_perf_bucket_of(p_content_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    (SELECT b.bucket FROM public.mos_content c
      JOIN public.mos_load_buckets b ON b.content_type_id = c.content_type_id
     WHERE c.id = p_content_id),
    (SELECT CASE WHEN t.key = 'video' THEN 'video' ELSE 'post' END
       FROM public.mos_content c JOIN public.mos_content_types t ON t.id = c.content_type_id
      WHERE c.id = p_content_id),
    'post');
$$;

-- SLA hours for (role_key, bucket, step): exact step → bucket any-step → role-wide.
CREATE OR REPLACE FUNCTION public.mos_perf_sla_hours(p_role_key text, p_bucket text, p_step_key text)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT s.sla_hours FROM public.mos_role_sla s
  JOIN public.roles r ON r.id = s.role_id
  WHERE r.key = 'mos_' || p_role_key
    AND (s.bucket = p_bucket OR s.bucket = '*')
    AND (s.step_key = COALESCE(p_step_key, '*') OR s.step_key = '*')
  ORDER BY (s.bucket <> '*') DESC, (s.step_key <> '*') DESC
  LIMIT 1;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Placement — the capacity engine
-- ────────────────────────────────────────────────────────────────────────────
-- Given a freshly-opened workflow task: resolve its bucket, pick the earliest
-- (day, person) whose remaining intake for (role, bucket) is > 0, stamp
-- assignee_user_id + opened_at (the intake day) + due_at (opened + SLA,
-- shifted past approved leave). Degrades gracefully at every step:
--   no capacity row / zero capacity → assignee stays NULL, SLA due only
--   no SLA row                      → keeps the legacy due_days due_at
-- Intake counts tasks by the day they OPENED (closing frees nothing).

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
    -- Earliest day with a free slot, up to 30 days out. Beyond that the task
    -- stays unassigned and the manager desk shows the structural gap.
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
        -- Today's placement opens now; a future day's opens at Riyadh midnight.
        IF v_offset > 0 THEN
          v_opened := (v_day::timestamp AT TIME ZONE 'Asia/Riyadh');
        END IF;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  v_sla := public.mos_perf_sla_hours(v_task.role_key, v_bucket, v_task.step_key);
  IF v_sla IS NOT NULL THEN
    v_due := v_opened + (v_sla * interval '1 hour');
    -- Leave pauses the clock: extend the due by the approved-leave hours that
    -- overlap the working window (single-pass approximation, documented).
    IF v_pick IS NOT NULL THEN
      SELECT COALESCE(sum(EXTRACT(EPOCH FROM (LEAST(l.end_at, v_due) - GREATEST(l.start_at, v_opened))) / 3600.0), 0)
        INTO v_leave_h
        FROM public.mos_leaves l
       WHERE l.user_id = v_pick AND l.status = 'approved'
         AND l.start_at < v_due AND l.end_at > v_opened;
      IF v_leave_h > 0 THEN v_due := v_due + (v_leave_h * interval '1 hour'); END IF;
    END IF;
  END IF;

  UPDATE public.workflow_role_tasks
     SET assignee_user_id = COALESCE(v_pick, assignee_user_id),
         opened_at        = v_opened,
         due_at           = COALESCE(v_due, due_at),
         updated_at       = now()
   WHERE id = p_task_id;
EXCEPTION WHEN OTHERS THEN
  -- Placement is an enhancement on top of the task chain; the open task itself
  -- must survive a placement bug. Loud in the DB logs, never silent.
  RAISE WARNING 'mos_perf_place_open_task(%) failed: % %', p_task_id, SQLSTATE, SQLERRM;
END $$;

REVOKE ALL ON FUNCTION public.mos_perf_place_open_task(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_perf_place_open_task(uuid) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. workflow_advance_role_path — VERBATIM live definition + ONE addition
--    (placement after the INSERT of the next open task)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.workflow_advance_role_path(p_subject_table text, p_subject_id uuid, p_result text, p_note text DEFAULT NULL::text, p_targets jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_task      public.workflow_role_tasks%ROWTYPE;
  v_roles     text[];
  v_steps     jsonb;
  v_version   uuid;
  v_idx       integer;
  v_next      jsonb;
  v_new_id    uuid;
  v_round     integer;
  v_closed_by uuid;
BEGIN
  -- The engine is generic; only the marketing subject is wired up so far.
  IF p_subject_table <> 'mos_content' THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table
      USING ERRCODE = 'feature_not_supported';
  END IF;

  SELECT * INTO v_task
    FROM public.workflow_role_tasks
   WHERE subject_table = p_subject_table
     AND subject_id    = p_subject_id
     AND status        = 'open'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:NO_OPEN_TASK';
  END IF;

  -- Definer rights bypass RLS, so the task-level authorization lives here:
  -- admins and the Marketing Manager may move anyone's task; otherwise the
  -- caller must HOLD the task's role or BE its assignee.
  -- NOTE: the assignee comparison MUST be COALESCE'd — an unassigned task has
  -- assignee_user_id IS NULL, and `NULL = me` is NULL, which would make the
  -- whole OR-chain NULL and `IF NOT (NULL)` fail OPEN (the 2026-08-03 bug).
  v_roles := public.wassell_mos_roles(auth.uid());
  IF NOT (
       'administrator'     = ANY(v_roles)
    OR 'marketing_manager' = ANY(v_roles)
    OR v_task.role_key     = ANY(v_roles)
    OR COALESCE(v_task.assignee_user_id = public.wassell_app_user_id(auth.uid()), false)
  ) THEN
    RAISE EXCEPTION 'MOS:NOT_YOUR_TASK' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_result NOT IN ('submitted','approved','changes_requested') THEN
    RAISE EXCEPTION 'MOS:BAD_RESULT %', p_result;
  END IF;
  -- Mirrors the reject-note CHECK so the caller gets a sentence, not a violation.
  IF p_result = 'changes_requested'
     AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED';
  END IF;

  -- The PINNED definition, never the live workflow row.
  SELECT c.workflow_version_id, v.definition->'metadata'->'steps'
    INTO v_version, v_steps
    FROM public.mos_content c
    LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
   WHERE c.id = p_subject_id;

  v_closed_by := public.wassell_app_user_id(auth.uid());

  UPDATE public.workflow_role_tasks
     SET status           = 'done',
         result           = p_result,
         note             = p_note,
         revision_targets = COALESCE(p_targets, '[]'::jsonb),
         closed_at        = now(),
         closed_by_user_id = v_closed_by
   WHERE id = v_task.id;

  -- Content not bound to a version (no workflow): close and stop — 'done'.
  IF v_steps IS NULL
     OR jsonb_typeof(v_steps) <> 'array'
     OR jsonb_array_length(v_steps) = 0 THEN
    RETURN jsonb_build_object(
      'closed_task_id', v_task.id, 'opened_task_id', NULL,
      'next_step_key', NULL, 'round', v_task.round, 'done', true);
  END IF;

  -- 0-based index of the current step within the pinned array.
  SELECT ord - 1 INTO v_idx
    FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
   WHERE elem->>'key' = v_task.step_key;

  IF p_result = 'changes_requested' THEN
    -- Back to the LAST step before the current one that creates revisions;
    -- if none does, the first step. The round increments so the loop stays
    -- visible in the task chain rather than overwriting the record it came from.
    SELECT elem INTO v_next
      FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
     WHERE ord - 1 < COALESCE(v_idx, 0)
       AND COALESCE((elem->>'creates_revision')::boolean, false)
     ORDER BY ord DESC
     LIMIT 1;
    IF v_next IS NULL THEN
      v_next := v_steps -> 0;
    END IF;
    v_round := v_task.round + 1;
  ELSE
    IF v_idx IS NOT NULL AND v_idx < jsonb_array_length(v_steps) - 1 THEN
      v_next := v_steps -> (v_idx + 1);
    ELSE
      v_next := NULL;  -- last step: no successor, the record is done
    END IF;
    v_round := v_task.round;
  END IF;

  IF v_next IS NOT NULL THEN
    INSERT INTO public.workflow_role_tasks
      (subject_table, subject_id, workflow_version_id, step_key, role_key,
       round, due_at)
    VALUES
      (p_subject_table, p_subject_id, v_version,
       v_next->>'key', v_next->>'role_key', v_round,
       now() + COALESCE((v_next->>'due_days')::int, 2) * interval '1 day')
    RETURNING id INTO v_new_id;

    -- Performance/load system (2026-08-28): capacity-aware placement + SLA due.
    -- Never breaks the advance — the function traps its own errors.
    PERFORM public.mos_perf_place_open_task(v_new_id);
  END IF;

  RETURN jsonb_build_object(
    'closed_task_id', v_task.id,
    'opened_task_id', v_new_id,
    'next_step_key',  CASE WHEN v_next IS NULL THEN NULL ELSE v_next->>'key' END,
    'round',          v_round,
    'done',           v_next IS NULL);
END $function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. workflow_role_path_start — VERBATIM live definition + the same addition
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.workflow_role_path_start(p_subject_table text, p_subject_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_steps  jsonb;
  v_first  jsonb;
  v_ver    uuid;
  v_new_id uuid;
BEGIN
  IF p_subject_table <> 'mos_content' THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- The creation right, not the assignment right.
  IF NOT public.wassell_mos_can('write_content') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Idempotent: an open task already derives the subject's state.
  IF EXISTS (SELECT 1 FROM public.workflow_role_tasks
              WHERE subject_table = p_subject_table
                AND subject_id = p_subject_id AND status = 'open') THEN
    RETURN jsonb_build_object('opened_task_id', NULL, 'already_open', true);
  END IF;

  SELECT c.workflow_version_id, v.definition->'metadata'->'steps'
    INTO v_ver, v_steps
    FROM public.mos_content c
    LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
   WHERE c.id = p_subject_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:SUBJECT_NOT_FOUND';
  END IF;

  IF v_steps IS NULL OR jsonb_typeof(v_steps) <> 'array'
     OR jsonb_array_length(v_steps) = 0 THEN
    RETURN jsonb_build_object('opened_task_id', NULL, 'already_open', false);
  END IF;

  v_first := v_steps -> 0;
  INSERT INTO public.workflow_role_tasks
    (subject_table, subject_id, workflow_version_id, step_key, role_key, round, due_at)
  VALUES
    (p_subject_table, p_subject_id, v_ver,
     v_first->>'key', v_first->>'role_key', 1,
     now() + COALESCE((v_first->>'due_days')::int, 2) * interval '1 day')
  RETURNING id INTO v_new_id;

  -- Performance/load system (2026-08-28): capacity-aware placement + SLA due.
  PERFORM public.mos_perf_place_open_task(v_new_id);

  RETURN jsonb_build_object('opened_task_id', v_new_id, 'already_open', false);
END $function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. On-time XP — +2 when a task closes at or before its due date
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_perf_on_task_close()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user uuid;
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'done'
     AND NEW.due_at IS NOT NULL AND NEW.closed_at IS NOT NULL
     AND NEW.closed_at <= NEW.due_at
     AND COALESCE((SELECT xp_rewards_enabled FROM public.mos_perf_settings WHERE id), false)
  THEN
    v_user := COALESCE(NEW.assignee_user_id, NEW.closed_by_user_id);
    IF v_user IS NOT NULL THEN
      INSERT INTO public.mos_xp_ledger (user_id, source, ref_id, points, note)
      VALUES (v_user, 'on_time', NEW.id, 2, 'closed before due')
      ON CONFLICT (ref_id) WHERE source = 'on_time' DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mos_perf_wrt_on_close ON public.workflow_role_tasks;
CREATE TRIGGER mos_perf_wrt_on_close AFTER UPDATE ON public.workflow_role_tasks
  FOR EACH ROW EXECUTE FUNCTION public.mos_perf_on_task_close();
DROP TRIGGER IF EXISTS mos_perf_mmt_on_close ON public.mos_manual_tasks;
CREATE TRIGGER mos_perf_mmt_on_close AFTER UPDATE ON public.mos_manual_tasks
  FOR EACH ROW EXECUTE FUNCTION public.mos_perf_on_task_close();

-- ────────────────────────────────────────────────────────────────────────────
-- 6. Late sweep — cron-driven (service_role only)
-- ────────────────────────────────────────────────────────────────────────────
-- For every open, non-blocked task past its due whose owner is not on approved
-- leave: set late_flag, record ONE late event, and create the month-ordinal
-- discipline action (1-3 warning, 4+ deduction). Idempotent at every step.

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

    -- In-app nudge to the person (notify_emit fires in-app unconditionally
    -- when no channel mask is passed; push/whatsapp follow the role grid).
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

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Rating → XP
-- ────────────────────────────────────────────────────────────────────────────
-- One overall level for every contributor of a done creative, with optional
-- per-user overrides ({"<user_id>":"<level>"}). Re-rating adjusts: the base
-- 'rating' XP row is unique per rating; deltas land as 'adjustment' rows.

CREATE OR REPLACE FUNCTION public.mos_perf_rate_content(
  p_content_id uuid, p_level text, p_overrides jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_points  int;
  v_rater   uuid := public.wassell_app_user_id(auth.uid());
  v_count   int := 0;
  rec       record;
  v_level   text;
  v_pts     int;
  v_rating  uuid;
  v_old_pts int;
BEGIN
  IF NOT public.wassell_mos_can('rate_creative') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT COALESCE((SELECT ratings_enabled FROM public.mos_perf_settings WHERE id), false) THEN
    RAISE EXCEPTION 'MOS:RATINGS_DISABLED';
  END IF;
  IF p_level NOT IN ('normal','good','very_good','excellent','very_excellent') THEN
    RAISE EXCEPTION 'MOS:BAD_LEVEL %', p_level;
  END IF;
  -- Rate only finished creatives: no open task, at least one done task.
  IF EXISTS (SELECT 1 FROM public.workflow_role_tasks
              WHERE subject_table = 'mos_content' AND subject_id = p_content_id AND status = 'open') THEN
    RAISE EXCEPTION 'MOS:CONTENT_NOT_DONE';
  END IF;

  FOR rec IN
    SELECT DISTINCT ON (t.assignee_user_id) t.assignee_user_id AS user_id, t.role_key
      FROM public.workflow_role_tasks t
     WHERE t.subject_table = 'mos_content' AND t.subject_id = p_content_id
       AND t.status = 'done' AND t.assignee_user_id IS NOT NULL
     ORDER BY t.assignee_user_id, t.closed_at DESC
  LOOP
    v_level := COALESCE(p_overrides->>rec.user_id::text, p_level);
    IF v_level NOT IN ('normal','good','very_good','excellent','very_excellent') THEN
      v_level := p_level;
    END IF;
    v_pts := CASE v_level
      WHEN 'normal' THEN 1 WHEN 'good' THEN 2 WHEN 'very_good' THEN 4
      WHEN 'excellent' THEN 7 ELSE 10 END;

    SELECT id, points INTO v_rating, v_old_pts
      FROM public.mos_creative_ratings
     WHERE content_id = p_content_id AND contributor_user_id = rec.user_id;

    IF v_rating IS NULL THEN
      INSERT INTO public.mos_creative_ratings
        (content_id, contributor_user_id, contributor_role_key, level,
         is_override, points, rated_by)
      VALUES (p_content_id, rec.user_id, rec.role_key, v_level,
              (p_overrides ? rec.user_id::text), v_pts, v_rater)
      RETURNING id INTO v_rating;
      IF COALESCE((SELECT xp_rewards_enabled FROM public.mos_perf_settings WHERE id), false) THEN
        INSERT INTO public.mos_xp_ledger (user_id, source, ref_id, points, note)
        VALUES (rec.user_id, 'rating', v_rating, v_pts, v_level)
        ON CONFLICT (ref_id) WHERE source = 'rating' DO NOTHING;
      END IF;
    ELSE
      UPDATE public.mos_creative_ratings
         SET level = v_level, points = v_pts,
             is_override = (p_overrides ? rec.user_id::text),
             rated_by = v_rater, updated_at = now()
       WHERE id = v_rating;
      IF v_old_pts <> v_pts
         AND COALESCE((SELECT xp_rewards_enabled FROM public.mos_perf_settings WHERE id), false) THEN
        INSERT INTO public.mos_xp_ledger (user_id, source, ref_id, points, note)
        VALUES (rec.user_id, 'adjustment', v_rating, v_pts - v_old_pts, 're-rated to ' || v_level);
      END IF;
    END IF;
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'MOS:NO_CONTRIBUTORS';
  END IF;
  RETURN jsonb_build_object('rated', v_count);
END $$;

REVOKE ALL ON FUNCTION public.mos_perf_rate_content(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_perf_rate_content(uuid, text, jsonb) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 8. Rewards — claim (self) + decide (manager)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_perf_claim_reward(p_reward_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user   uuid := public.wassell_app_user_id(auth.uid());
  v_reward public.mos_rewards%ROWTYPE;
  v_bal    int;
  v_id     uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_reward FROM public.mos_rewards WHERE id = p_reward_id AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'MOS:REWARD_NOT_FOUND'; END IF;
  SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.mos_xp_ledger WHERE user_id = v_user;
  -- Pending claims reserve their cost so two claims can't spend the same XP.
  SELECT v_bal - COALESCE(sum(cost_xp), 0) INTO v_bal
    FROM public.mos_reward_claims WHERE user_id = v_user AND status = 'requested';
  IF v_bal < v_reward.cost_xp THEN RAISE EXCEPTION 'MOS:INSUFFICIENT_XP'; END IF;
  INSERT INTO public.mos_reward_claims (user_id, reward_id, cost_xp)
  VALUES (v_user, p_reward_id, v_reward.cost_xp) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.mos_perf_decide_reward(p_claim_id uuid, p_approve boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_claim public.mos_reward_claims%ROWTYPE;
  v_bal   int;
BEGIN
  IF NOT public.wassell_mos_can('manage_performance') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_claim FROM public.mos_reward_claims WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND OR v_claim.status <> 'requested' THEN RAISE EXCEPTION 'MOS:CLAIM_NOT_PENDING'; END IF;
  IF p_approve THEN
    SELECT COALESCE(sum(points), 0) INTO v_bal FROM public.mos_xp_ledger WHERE user_id = v_claim.user_id;
    IF v_bal < v_claim.cost_xp THEN RAISE EXCEPTION 'MOS:INSUFFICIENT_XP'; END IF;
    UPDATE public.mos_reward_claims
       SET status = 'approved', decided_by = public.wassell_app_user_id(auth.uid()), decided_at = now()
     WHERE id = p_claim_id;
    -- XP is spent on APPROVAL, never on request — a rejected claim costs nothing.
    INSERT INTO public.mos_xp_ledger (user_id, source, ref_id, points, note)
    VALUES (v_claim.user_id, 'reward_spend', p_claim_id, -v_claim.cost_xp, 'reward approved');
  ELSE
    UPDATE public.mos_reward_claims
       SET status = 'rejected', decided_by = public.wassell_app_user_id(auth.uid()), decided_at = now()
     WHERE id = p_claim_id;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.mos_perf_claim_reward(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mos_perf_decide_reward(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_perf_claim_reward(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mos_perf_decide_reward(uuid, boolean) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 9. Discipline — decide (manager) + dispute (self)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_perf_decide_discipline(p_action_id uuid, p_approve boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_action public.mos_discipline_actions%ROWTYPE;
  v_s      public.mos_perf_settings%ROWTYPE;
BEGIN
  IF NOT public.wassell_mos_can('manage_performance') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_s FROM public.mos_perf_settings WHERE id;
  SELECT * INTO v_action FROM public.mos_discipline_actions WHERE id = p_action_id FOR UPDATE;
  IF NOT FOUND OR v_action.status NOT IN ('pending','disputed') THEN
    RAISE EXCEPTION 'MOS:ACTION_NOT_PENDING';
  END IF;
  -- Observe mode / deductions-off: a deduction cannot be APPROVED until the
  -- operator flips the toggles. Rejection is always allowed.
  IF p_approve AND v_action.kind = 'deduction'
     AND (v_s.discipline_observe OR NOT v_s.deductions_enabled) THEN
    RAISE EXCEPTION 'MOS:DEDUCTIONS_DISABLED';
  END IF;
  UPDATE public.mos_discipline_actions
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         decided_by = public.wassell_app_user_id(auth.uid()), decided_at = now()
   WHERE id = p_action_id;
END $$;

CREATE OR REPLACE FUNCTION public.mos_perf_dispute_discipline(p_action_id uuid, p_note text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user uuid := public.wassell_app_user_id(auth.uid());
BEGIN
  IF NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED';
  END IF;
  UPDATE public.mos_discipline_actions
     SET dispute_note = p_note, status = 'disputed'
   WHERE id = p_action_id AND user_id = v_user AND status = 'pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'MOS:ACTION_NOT_PENDING'; END IF;
END $$;

REVOKE ALL ON FUNCTION public.mos_perf_decide_discipline(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mos_perf_dispute_discipline(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_perf_decide_discipline(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mos_perf_dispute_discipline(uuid, text) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 10. Leaves — request (self) + decide (manager; approval shifts open dues)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_leave_request(
  p_start timestamptz, p_end timestamptz, p_kind text, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_user uuid := public.wassell_app_user_id(auth.uid());
  v_id   uuid;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_end <= p_start THEN RAISE EXCEPTION 'MOS:BAD_RANGE'; END IF;
  INSERT INTO public.mos_leaves (user_id, start_at, end_at, kind, note)
  VALUES (v_user, p_start, p_end,
          CASE WHEN p_kind IN ('annual','sick','other') THEN p_kind ELSE 'other' END, p_note)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.mos_leave_decide(p_leave_id uuid, p_approve boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_leave public.mos_leaves%ROWTYPE;
  v_shift interval;
BEGIN
  IF NOT public.wassell_mos_can('manage_performance') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_leave FROM public.mos_leaves WHERE id = p_leave_id FOR UPDATE;
  IF NOT FOUND OR v_leave.status <> 'requested' THEN RAISE EXCEPTION 'MOS:LEAVE_NOT_PENDING'; END IF;
  UPDATE public.mos_leaves
     SET status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
         approved_by = public.wassell_app_user_id(auth.uid())
   WHERE id = p_leave_id;
  IF p_approve THEN
    -- The SLA clock pauses: every open task due after the leave starts gets
    -- the leave's duration added. (v1 posture from the approved spec.)
    v_shift := v_leave.end_at - v_leave.start_at;
    UPDATE public.workflow_role_tasks
       SET due_at = due_at + v_shift, updated_at = now()
     WHERE status = 'open' AND assignee_user_id = v_leave.user_id
       AND due_at IS NOT NULL AND due_at >= v_leave.start_at;
    UPDATE public.mos_manual_tasks
       SET due_at = due_at + v_shift, updated_at = now()
     WHERE status = 'open' AND assignee_user_id = v_leave.user_id
       AND due_at IS NOT NULL AND due_at >= v_leave.start_at;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.mos_leave_request(timestamptz, timestamptz, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mos_leave_decide(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_leave_request(timestamptz, timestamptz, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mos_leave_decide(uuid, boolean) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 11. Block / unblock (manager only; unblock re-anchors the due date)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_perf_task_block(
  p_task_source text, p_task_id uuid, p_blocked boolean, p_reason text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_by uuid := public.wassell_app_user_id(auth.uid());
BEGIN
  IF NOT public.wassell_mos_can('manage_performance') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_blocked AND NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED';
  END IF;
  IF p_task_source = 'workflow' THEN
    IF p_blocked THEN
      UPDATE public.workflow_role_tasks
         SET blocked = true, blocked_reason = p_reason, blocked_by = v_by,
             blocked_at = now(), updated_at = now()
       WHERE id = p_task_id AND status = 'open' AND NOT blocked;
    ELSE
      -- The block's duration never counts against the owner.
      UPDATE public.workflow_role_tasks
         SET blocked = false,
             due_at = CASE WHEN due_at IS NOT NULL AND blocked_at IS NOT NULL
                           THEN due_at + (now() - blocked_at) ELSE due_at END,
             updated_at = now()
       WHERE id = p_task_id AND blocked;
    END IF;
  ELSIF p_task_source = 'manual' THEN
    IF p_blocked THEN
      UPDATE public.mos_manual_tasks
         SET blocked = true, blocked_reason = p_reason, blocked_by = v_by,
             blocked_at = now(), updated_at = now()
       WHERE id = p_task_id AND status = 'open' AND NOT blocked;
    ELSE
      UPDATE public.mos_manual_tasks
         SET blocked = false,
             due_at = CASE WHEN due_at IS NOT NULL AND blocked_at IS NOT NULL
                           THEN due_at + (now() - blocked_at) ELSE due_at END,
             updated_at = now()
       WHERE id = p_task_id AND blocked;
    END IF;
  ELSE
    RAISE EXCEPTION 'MOS:BAD_TASK_SOURCE %', p_task_source;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'MOS:TASK_NOT_FOUND'; END IF;
END $$;

REVOKE ALL ON FUNCTION public.mos_perf_task_block(text, uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_perf_task_block(text, uuid, boolean, text) TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- 12. KPI — monthly paid snapshot (cron) + evaluation
-- ────────────────────────────────────────────────────────────────────────────

-- Ranged Meta insights land here, one row per (month, campaign execution).
-- p_rows: [{platform_campaign_id, spend, impressions, clicks, leads}]
CREATE OR REPLACE FUNCTION public.mos_perf_paid_monthly_upsert(p_month text, p_rows jsonb)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  rec     jsonb;
  v_exec  uuid;
  v_camp  uuid;
  v_count int := 0;
BEGIN
  FOR rec IN SELECT value FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) AS t(value) LOOP
    SELECT e.id, e.campaign_id INTO v_exec, v_camp
      FROM public.mos_campaign_executions e
     WHERE e.platform = 'meta' AND e.platform_campaign_id = rec->>'platform_campaign_id';
    CONTINUE WHEN v_exec IS NULL;
    INSERT INTO public.mos_perf_paid_monthly
      (month_key, execution_id, campaign_id, spend, impressions, clicks, leads, synced_at)
    VALUES
      (p_month, v_exec, v_camp,
       NULLIF(rec->>'spend','')::numeric, NULLIF(rec->>'impressions','')::bigint,
       NULLIF(rec->>'clicks','')::bigint, NULLIF(rec->>'leads','')::bigint, now())
    ON CONFLICT (month_key, execution_id) DO UPDATE SET
      campaign_id = EXCLUDED.campaign_id, spend = EXCLUDED.spend,
      impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
      leads = EXCLUDED.leads, synced_at = now();
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

REVOKE ALL ON FUNCTION public.mos_perf_paid_monthly_upsert(text, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.mos_perf_paid_monthly_upsert(text, jsonb) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.mos_perf_paid_monthly_upsert(text, jsonb) TO service_role;

-- Evaluate every goal of a month against the snapshot. Idempotent upsert; safe
-- to run on every read of the KPI status.
CREATE OR REPLACE FUNCTION public.mos_perf_kpi_evaluate(p_month text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  g        record;
  v_spend  numeric; v_imps bigint; v_clicks bigint; v_leads bigint;
  v_actual numeric;
  v_hit    boolean;
  v_count  int := 0;
BEGIN
  IF NOT public.wassell_mos_can('read') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR g IN SELECT * FROM public.mos_perf_kpi_goals WHERE month_key = p_month LOOP
    SELECT COALESCE(sum(spend),0), COALESCE(sum(impressions),0),
           COALESCE(sum(clicks),0), COALESCE(sum(leads),0)
      INTO v_spend, v_imps, v_clicks, v_leads
      FROM public.mos_perf_paid_monthly m
     WHERE m.month_key = p_month
       AND (g.scope_campaign_ids IS NULL OR m.campaign_id = ANY(g.scope_campaign_ids));

    v_actual := CASE g.metric
      WHEN 'cpl'   THEN CASE WHEN v_leads  > 0 THEN v_spend  / v_leads  END
      WHEN 'ctr'   THEN CASE WHEN v_imps   > 0 THEN v_clicks::numeric / v_imps END
      WHEN 'cpc'   THEN CASE WHEN v_clicks > 0 THEN v_spend  / v_clicks END
      WHEN 'leads' THEN v_leads
      WHEN 'spend' THEN v_spend
    END;
    v_hit := v_actual IS NOT NULL AND (
      (g.comparator = 'lte' AND v_actual <= g.target) OR
      (g.comparator = 'gte' AND v_actual >= g.target));

    INSERT INTO public.mos_perf_kpi_results (goal_id, actual, hit, evaluated_at)
    VALUES (g.id, v_actual, v_hit, now())
    ON CONFLICT (goal_id) DO UPDATE SET
      actual = EXCLUDED.actual, hit = EXCLUDED.hit, evaluated_at = now();
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('month', p_month, 'evaluated', v_count);
END $$;

REVOKE ALL ON FUNCTION public.mos_perf_kpi_evaluate(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mos_perf_kpi_evaluate(text) TO authenticated, service_role;

COMMIT;
