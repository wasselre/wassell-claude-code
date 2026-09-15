-- ============================================================================
-- Group C1 + C2 — the ROW as a task subject, and a placer that stops lying.
-- 2026-09-15.
--
-- A row is three posts, one task to work, one task to approve. Until now every
-- engine function hard-filtered `subject_table = 'mos_content'`, so a row task
-- created perfectly by the planner would open with NO reservation, NO assignee
-- and NO window — and `mos_perf_place_open_task` would have swallowed the
-- reason in a blanket `EXCEPTION WHEN OTHERS`.
--
-- What this migration changes:
--   0. Four subject helpers so "the bucket / the workflow key / the pinned
--      version of this subject" is answered in ONE place for both kinds.
--   1. `mos_plan_consume_reservation` — matches a row reservation by `row_id`
--      (or `row_key`), and takes the row's deadline from its members.
--   2. `mos_perf_place_open_task` — row-aware bucket; an unresolvable subject
--      now RAISES instead of producing a silent unassigned task; the blanket
--      catch is narrowed to the one data condition it actually means to
--      swallow; an unassigned task always says WHY in the log.
--   3. `workflow_role_path_start` — opens the first task on a row.
--   4. `mos_plan_start_due` — opens row tasks when their reservation's
--      production day arrives, and STOPS opening per-member tasks for content
--      that belongs to a row (that is what the row replaces).
--
-- D1 safety: nothing here re-points an existing record. The 24 pre-cutover
-- content items have no `row_id`, so every row arm below is dead for them.
--
-- Live state when written: 0 rows in mos_content_rows, mos_task_reservations
-- and mos_content_plan — the row path is greenfield.
--
-- Idempotent: CREATE OR REPLACE throughout, no DDL on tables.
-- No function here raises SQLSTATE 40001/40P01.
-- ============================================================================

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 0. Subject helpers
-- ----------------------------------------------------------------------------
-- `mos_perf_bucket_of` takes a CONTENT id. Handed a row id it silently falls
-- through its last COALESCE and answers 'post' — right by accident for a post
-- row, wrong for a video row. These resolve the subject explicitly instead.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_row_bucket(p_row_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  -- A row's load bucket is its members'. 'video' wins if ANY member is a video
  -- (a row is charged on one day; the heavier bucket is the honest one).
  SELECT COALESCE(
    (SELECT 'video' FROM public.mos_content c
      WHERE c.row_id = p_row_id
        AND public.mos_perf_bucket_of(c.id) = 'video' LIMIT 1),
    (SELECT public.mos_perf_bucket_of(c.id) FROM public.mos_content c
      WHERE c.row_id = p_row_id
      ORDER BY c.row_order NULLS LAST, c.created_at LIMIT 1),
    'post');
$function$;

CREATE OR REPLACE FUNCTION public.mos_subject_bucket(p_subject_table text, p_subject_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE p_subject_table
           WHEN 'mos_content_rows' THEN public.mos_row_bucket(p_subject_id)
           WHEN 'mos_content'      THEN public.mos_perf_bucket_of(p_subject_id)
           ELSE 'post'
         END;
$function$;

CREATE OR REPLACE FUNCTION public.mos_subject_workflow_key(p_subject_table text, p_subject_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN public.mos_subject_bucket(p_subject_table, p_subject_id) = 'video'
              THEN 'video_std' ELSE 'post_std' END;
$function$;

-- The PINNED workflow version of a subject. A row carries its own because
-- `workflow_advance_role_path` reads the step list off the subject and a row
-- has no `mos_content` to read it from.
CREATE OR REPLACE FUNCTION public.mos_subject_version_id(p_subject_table text, p_subject_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE p_subject_table
           WHEN 'mos_content_rows'
             THEN (SELECT r.workflow_version_id FROM public.mos_content_rows r WHERE r.id = p_subject_id)
           WHEN 'mos_content'
             THEN (SELECT c.workflow_version_id FROM public.mos_content c WHERE c.id = p_subject_id)
           ELSE NULL
         END;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- C1. mos_plan_consume_reservation — teach it the row subject
-- ----------------------------------------------------------------------------
-- Two changes beyond "also accept a row":
--
--  * The content arm now also requires `r.row_id IS NULL` on its key fallback.
--    Without it the arm reads "content_id IS NULL AND content_key matches" —
--    and since `mos_task_reservations_one_subject` makes `content_id IS NULL`
--    mean "this is a ROW reservation", a content task could have STOLEN a
--    row's reservation through a shared key. That hazard was created by the
--    row_id column, not by this function, but this is where it bites.
--
--  * A row has no `mos_content_plan` row of its own, so its stage deadline is
--    the EARLIEST of its members'. They share a batch day, so they agree; MIN
--    is the reading that can never be late.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_plan_consume_reservation(p_task_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_task   public.workflow_role_tasks%ROWTYPE;
  v_res    public.mos_task_reservations%ROWTYPE;
  v_key    text;
  v_days   numeric;
  v_deadline date;
  v_is_row boolean;
BEGIN
  PERFORM public.mos_ledger_lock();

  SELECT * INTO v_task FROM public.workflow_role_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR v_task.status <> 'open'
     OR v_task.subject_table NOT IN ('mos_content', 'mos_content_rows') THEN
    RETURN NULL;
  END IF;
  IF v_task.reservation_id IS NOT NULL THEN
    RETURN v_task.reservation_id;
  END IF;

  v_is_row := v_task.subject_table = 'mos_content_rows';

  IF v_is_row THEN
    SELECT r.row_key INTO v_key
      FROM public.mos_content_rows r WHERE r.id = v_task.subject_id;
  ELSE
    SELECT cp.content_key INTO v_key
      FROM public.mos_content_plan cp WHERE cp.content_id = v_task.subject_id;
  END IF;

  SELECT * INTO v_res
    FROM public.mos_task_reservations r
   WHERE r.status IN ('reserved','stale')
     AND r.step_key = v_task.step_key
     AND (CASE WHEN v_is_row THEN
                 r.row_id = v_task.subject_id
                 OR (r.row_id IS NULL AND r.content_id IS NULL
                     AND v_key IS NOT NULL AND r.content_key = v_key)
               ELSE
                 r.content_id = v_task.subject_id
                 OR (r.content_id IS NULL AND r.row_id IS NULL
                     AND v_key IS NOT NULL AND r.content_key = v_key)
          END)
   ORDER BY (CASE WHEN v_is_row THEN r.row_id IS NOT NULL
                  ELSE r.content_id IS NOT NULL END) DESC,
            r.planned_start
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- weight IS the total effort in slot-days; the task inherits it verbatim.
  -- A row reserved at weight 3 stays weight 3 — `mos_work_ledger_v` charges it
  -- on ONE day via mos_spread_effort_same_day, which is what a row means.
  v_days := GREATEST(v_res.weight, 0.5);

  IF v_is_row THEN
    SELECT min((cp.stage_deadlines ->> v_task.step_key)::date) INTO v_deadline
      FROM public.mos_content c
      JOIN public.mos_content_plan cp ON cp.content_id = c.id
     WHERE c.row_id = v_task.subject_id;
  ELSE
    SELECT (cp.stage_deadlines ->> v_task.step_key)::date INTO v_deadline
      FROM public.mos_content_plan cp WHERE cp.content_id = v_task.subject_id;
  END IF;

  UPDATE public.mos_task_reservations
     SET status           = 'consumed',
         consumed_task_id = v_task.id,
         -- exactly one of the two is written, so the one-subject CHECK holds.
         content_id       = CASE WHEN v_is_row THEN content_id ELSE v_task.subject_id END,
         row_id           = CASE WHEN v_is_row THEN v_task.subject_id ELSE row_id END,
         updated_at       = now()
   WHERE id = v_res.id;

  UPDATE public.workflow_role_tasks
     SET assignee_user_id = COALESCE(v_res.assignee_user_id, assignee_user_id),
         scheduled_start  = v_res.planned_start,
         scheduled_end    = v_res.planned_end,
         effort_days      = v_days,
         reservation_id   = v_res.id,
         bucket           = COALESCE(bucket, v_res.bucket),
         due_at           = (LEAST(COALESCE(v_deadline, v_res.planned_end), v_res.planned_end)
                               + interval '1 day' - interval '1 second') AT TIME ZONE 'Asia/Riyadh'
   WHERE id = v_task.id;

  RETURN v_res.id;
END $function$;

-- ────────────────────────────────────────────────────────────────────────────
-- C2. mos_perf_place_open_task — stop swallowing everything
-- ----------------------------------------------------------------------------
-- The old body ended in `EXCEPTION WHEN OTHERS THEN RAISE WARNING`. That turned
-- FOUR different structural bugs into the same silent outcome — a task that
-- opens with no assignee and is reachable only by role:
--   * a subject_table the function does not understand
--   * a subject id that no longer exists
--   * a role_key with no matching `mos_<key>` row in `roles`
--   * anything at all thrown by the capacity search
--
-- The first three now RAISE. The fourth keeps a catch, but only for the ONE
-- data condition that can legitimately arise from a bad row rather than a bug:
-- `users.role_assignments` holding something that is not a JSON array, which
-- makes `jsonb_array_elements` throw 22023 — one malformed user record must not
-- block everyone else's task placement. It is logged, never silent.
--
-- And when nobody could be picked for a legitimate reason (nobody holds the
-- role, the role has no intake configured, or every holder is at cap for 30
-- days) the function now says which, instead of returning quietly.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_perf_place_open_task(p_task_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  v_holders  int;
BEGIN
  SELECT * INTO v_task FROM public.workflow_role_tasks WHERE id = p_task_id;
  IF NOT FOUND OR v_task.status <> 'open' THEN RETURN; END IF;

  -- (0) The subject, resolved LOUDLY.
  IF v_task.subject_table NOT IN ('mos_content', 'mos_content_rows') THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT % (task %)', v_task.subject_table, p_task_id
      USING ERRCODE = 'feature_not_supported';
  END IF;
  IF v_task.subject_table = 'mos_content'
     AND NOT EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = v_task.subject_id) THEN
    RAISE EXCEPTION 'MOS:SUBJECT_NOT_FOUND mos_content % (task %)', v_task.subject_id, p_task_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_task.subject_table = 'mos_content_rows'
     AND NOT EXISTS (SELECT 1 FROM public.mos_content_rows r WHERE r.id = v_task.subject_id) THEN
    RAISE EXCEPTION 'MOS:SUBJECT_NOT_FOUND mos_content_rows % (task %)', v_task.subject_id, p_task_id
      USING ERRCODE = 'no_data_found';
  END IF;

  v_bucket := public.mos_subject_bucket(v_task.subject_table, v_task.subject_id);
  UPDATE public.workflow_role_tasks SET bucket = v_bucket WHERE id = p_task_id;

  SELECT r.id INTO v_role_id FROM public.roles r WHERE r.key = 'mos_' || v_task.role_key;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'MOS:ROLE_NOT_FOUND mos_% (task %)', v_task.role_key, p_task_id
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT l.daily_new_tasks INTO v_cap
    FROM public.mos_role_load l
   WHERE l.role_id = v_role_id AND l.bucket = v_bucket;

  v_opened := now();

  -- (1) The capacity search. The ONLY protected region, and only against a
  -- malformed `users.role_assignments` (22023 / 22P02) — see the header.
  BEGIN
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
  EXCEPTION
    WHEN invalid_parameter_value OR invalid_text_representation THEN
      -- A `users.role_assignments` value that is not a JSON array of objects.
      -- One bad user record must not stop everyone else's work being placed,
      -- but it is named here so it can be found and fixed.
      RAISE WARNING 'MOS:ROLE_ASSIGNMENTS_MALFORMED — capacity search for task % (role %) aborted: % %',
        p_task_id, v_task.role_key, SQLSTATE, SQLERRM;
      v_pick := NULL;
  END;

  -- (2) Why nobody was picked. Never a quiet return.
  IF v_pick IS NULL THEN
    SELECT count(*) INTO v_holders
      FROM public.users u
     WHERE u.is_active
       AND COALESCE(u.role_assignments, '[]'::jsonb) @> jsonb_build_array(
             jsonb_build_object('role_id', v_role_id::text));
    RAISE WARNING 'MOS:TASK_UNASSIGNED % (role=%, bucket=%, holders=%) — %',
      p_task_id, v_task.role_key, v_bucket, v_holders,
      CASE
        WHEN v_cap IS NULL THEN 'no mos_role_load row for this role and bucket'
        WHEN v_cap <= 0    THEN 'mos_role_load.daily_new_tasks is 0 for this role and bucket'
        WHEN v_holders = 0 THEN 'no active user holds this role'
        ELSE 'every holder is at their daily intake cap for the next 30 days'
      END;
  END IF;

  v_sla := LEAST(COALESCE(public.mos_perf_sla_hours(v_task.role_key, v_bucket, v_task.step_key), 24), 24);
  v_due := public.mos_perf_due_after(v_opened, v_sla);
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
END $function$;

-- ────────────────────────────────────────────────────────────────────────────
-- workflow_role_path_start — open the FIRST task on a row
-- ----------------------------------------------------------------------------
-- Not listed in Group C by name, but without it C1 and C5 are unreachable: this
-- is the only function that creates a first task, and it refused every subject
-- but `mos_content`.
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
  v_found  boolean;
BEGIN
  -- (a) THE LEDGER LOCK, FIRST STATEMENT.
  PERFORM public.mos_ledger_lock();

  IF p_subject_table NOT IN ('mos_content', 'mos_content_rows') THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- The creation right, not the assignment right.
  -- 2026-09-14: auth.uid() IS NULL means service_role (anon is revoked below),
  -- which is how the 10-minute planning sweep opens due work.
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('write_content') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Idempotent: an open task already derives the subject's state.
  IF EXISTS (SELECT 1 FROM public.workflow_role_tasks
              WHERE subject_table = p_subject_table
                AND subject_id = p_subject_id AND status = 'open') THEN
    RETURN jsonb_build_object('opened_task_id', NULL, 'already_open', true);
  END IF;

  IF p_subject_table = 'mos_content_rows' THEN
    SELECT true, r.workflow_version_id, v.definition->'metadata'->'steps'
      INTO v_found, v_ver, v_steps
      FROM public.mos_content_rows r
      LEFT JOIN public.workflow_versions v ON v.id = r.workflow_version_id
     WHERE r.id = p_subject_id;
  ELSE
    SELECT true, c.workflow_version_id, v.definition->'metadata'->'steps'
      INTO v_found, v_ver, v_steps
      FROM public.mos_content c
      LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
     WHERE c.id = p_subject_id;
  END IF;
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'MOS:SUBJECT_NOT_FOUND % %', p_subject_table, p_subject_id
      USING ERRCODE = 'no_data_found';
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

  -- (b) THE SWAP, before the legacy capacity-aware placer (2026-08-28).
  IF public.mos_plan_consume_reservation(v_new_id) IS NULL THEN
    PERFORM public.mos_perf_place_open_task(v_new_id);
  END IF;

  RETURN jsonb_build_object('opened_task_id', v_new_id, 'already_open', false);
END $function$;

-- ────────────────────────────────────────────────────────────────────────────
-- mos_plan_start_due — open ROW tasks, and stop opening per-member ones
-- ----------------------------------------------------------------------------
-- The content arm gains `AND c.row_id IS NULL`. Without it the sweep would
-- open three member tasks for a row AND the row task — the exact double that
-- the row model exists to remove.
--
-- A row has no `mos_content_plan` row, so its production day is its earliest
-- live reservation's `planned_start`. No new column needed.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_plan_start_due()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today   date := public.mos_perf_today();
  r         record;
  s         record;
  v_started int := 0;
  v_rows    int := 0;
  v_shells  int := 0;
  v_cycles  int := 0;
  v_ct      uuid;
  v_ver     uuid;
  v_new     uuid;
BEGIN
  PERFORM public.mos_ledger_lock();

  -- (1) ROWS whose production day has arrived. Before the loose-content arm,
  -- so a member can never be opened on its own by the same sweep.
  FOR r IN
    SELECT rw.id
      FROM public.mos_content_rows rw
     WHERE EXISTS (SELECT 1 FROM public.mos_task_reservations tr
                    WHERE tr.row_id = rw.id
                      AND tr.status IN ('reserved','stale')
                      AND tr.planned_start <= v_today)
       AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                        WHERE t.subject_table = 'mos_content_rows' AND t.subject_id = rw.id)
       AND EXISTS (SELECT 1 FROM public.mos_content c
                    WHERE c.row_id = rw.id AND c.archived_at IS NULL
                      AND c.on_hold_at IS NULL AND c.rejected_at IS NULL)
     ORDER BY rw.batch_day NULLS LAST, rw.id
  LOOP
    PERFORM public.workflow_role_path_start('mos_content_rows', r.id);
    UPDATE public.mos_content_plan cp
       SET status = 'in_production'
     WHERE cp.status = 'planned'
       AND cp.content_id IN (SELECT c.id FROM public.mos_content c WHERE c.row_id = r.id);
    v_rows := v_rows + 1;
    v_started := v_started + 1;
  END LOOP;

  -- (2) Loose content — anything NOT part of a row.
  FOR r IN
    SELECT cp.content_id
      FROM public.mos_content_plan cp
      JOIN public.mos_content c ON c.id = cp.content_id AND c.archived_at IS NULL
                               AND c.on_hold_at IS NULL AND c.rejected_at IS NULL
                               AND c.row_id IS NULL
     WHERE cp.status = 'planned'
       AND cp.production_start IS NOT NULL
       AND cp.production_start <= v_today
       AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                        WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id)
     ORDER BY cp.priority, cp.production_start
  LOOP
    PERFORM public.workflow_role_path_start('mos_content', r.content_id);
    UPDATE public.mos_content_plan SET status = 'in_production' WHERE content_id = r.content_id;
    v_started := v_started + 1;
  END LOOP;

  -- Anything already being worked is in production, whichever subject holds
  -- the open task.
  UPDATE public.mos_content_plan cp
     SET status = 'in_production'
   WHERE cp.status = 'planned'
     AND (EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                   WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id)
       OR EXISTS (SELECT 1 FROM public.mos_content c
                    JOIN public.workflow_role_tasks t
                      ON t.subject_table = 'mos_content_rows' AND t.subject_id = c.row_id
                   WHERE c.id = cp.content_id));

  FOR r IN
    SELECT cy.id AS cycle_id, cy.execution_id, cy.round, ex.campaign_id,
           cm.name AS campaign_name, cm.project_id
      FROM public.mos_refresh_cycles cy
      JOIN public.mos_campaign_executions ex ON ex.id = cy.execution_id
      LEFT JOIN public.mos_campaigns cm ON cm.id = ex.campaign_id
     WHERE cy.status = 'scheduled'
       AND cy.production_start_on IS NOT NULL
       AND cy.production_start_on <= v_today
     ORDER BY cy.production_start_on, cy.round
  LOOP
    SELECT ct.id,
           (SELECT wv.id FROM public.workflow_versions wv
             WHERE wv.workflow_id = ct.workflow_id ORDER BY wv.version_no DESC LIMIT 1)
      INTO v_ct, v_ver
      FROM public.mos_content_types ct WHERE ct.key = 'post' AND ct.archived_at IS NULL;

    IF v_ct IS NOT NULL THEN
      FOR s IN
        SELECT sl.id, sl.slot_index, sl.kind, sl.content_key
          FROM public.mos_creative_slots sl
         WHERE sl.cycle_id = r.cycle_id AND sl.content_id IS NULL
           AND sl.status = 'reserved'
         ORDER BY sl.slot_index
      LOOP
        INSERT INTO public.mos_content
          (content_type_id, workflow_id, workflow_version_id, title, project_id, project_ids,
           campaign_id, purpose)
        SELECT v_ct, ct.workflow_id, v_ver,
               COALESCE(r.campaign_name, 'حملة') || ' — تحديث ' || r.round || '/' || (s.slot_index + 1),
               r.project_id,
               CASE WHEN r.project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(r.project_id) END,
               r.campaign_id, 'paid'
          FROM public.mos_content_types ct WHERE ct.id = v_ct
        RETURNING id INTO v_new;

        UPDATE public.mos_creative_slots
           SET content_id = v_new, status = 'producing' WHERE id = s.id;

        UPDATE public.mos_task_reservations
           SET content_id = v_new
         WHERE content_id IS NULL AND row_id IS NULL AND cycle_id = r.cycle_id
           AND content_key IS NOT NULL AND content_key = s.content_key;

        IF NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                        WHERE t.subject_table = 'mos_content' AND t.subject_id = v_new) THEN
          PERFORM public.workflow_role_path_start('mos_content', v_new);
          v_started := v_started + 1;
        END IF;
        v_shells := v_shells + 1;
      END LOOP;
    END IF;

    UPDATE public.mos_refresh_cycles SET status = 'producing' WHERE id = r.cycle_id AND status = 'scheduled';
    v_cycles := v_cycles + 1;
  END LOOP;

  RETURN jsonb_build_object('started', v_started, 'rows_started', v_rows,
                            'shells_created', v_shells, 'cycles_started', v_cycles);
END $function$;

-- ───────────────────────────────────────────────────────────────────────────
-- Supabase grants anon EXECUTE on every NEW function in `public`, and
-- `REVOKE … FROM PUBLIC` does not touch it. Every pre-existing mos_* function
-- has anon revoked; these must match, or a definer helper leaks.
-- ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.mos_row_bucket(uuid)                 FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mos_subject_bucket(text, uuid)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mos_subject_workflow_key(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mos_subject_version_id(text, uuid)   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mos_row_bucket(uuid)                 TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mos_subject_bucket(text, uuid)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mos_subject_workflow_key(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mos_subject_version_id(text, uuid)   TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- Repo rule: no function in `public` may raise SQLSTATE 40001 / 40P01.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('mos_plan_consume_reservation','mos_perf_place_open_task',
                       'workflow_role_path_start','mos_plan_start_due',
                       'mos_row_bucket','mos_subject_bucket',
                       'mos_subject_workflow_key','mos_subject_version_id')
     AND (pg_get_functiondef(p.oid) ~ '''40001''' OR pg_get_functiondef(p.oid) ~ '''40P01'''
          OR pg_get_functiondef(p.oid) ~ 'serialization_failure'
          OR pg_get_functiondef(p.oid) ~ 'deadlock_detected');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'MOS:RETRYABLE_SQLSTATE in %', v_bad;
  END IF;
END $$;

COMMIT;
