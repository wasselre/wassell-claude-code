-- ============================================================================
-- Marketing OS task rules, part 2 of 2: ONE dispatcher. 2026-09-17.
--
-- Replaces the two assignment systems that disagreed:
--   · mos_plan_consume_reservation copied the month planner's NAMED person and
--     an end-of-planned-day deadline onto the task;
--   · mos_perf_place_open_task picked by "tasks opened today" and a 24h SLA.
-- Both now call mos_task_dispatch, and nothing else hands out work.
--
-- The rules (mos_step_rules, part 1):
--   · A task is handed to an active holder of its role who takes routine work
--     for it (mos_auto_assign_opt_out), taking turns: least recently assigned
--     for that role first.
--   · Capped steps (writing 10, design 4) hand out only while the person's
--     units RECEIVED in the last 24 hours leave room. Otherwise the task waits
--     (waiting_since / waiting_reason) — not late, nobody has received it.
--   · Deadline = received + the step's allowance (approved leave extends it).
--   · Confirmed work starts as soon as the first step's role has room, in
--     publish-date order. The planner's dates are a forecast; they no longer
--     gate starting.
--   · Someone who loses a role gives its open tasks back; they are re-handed.
--
-- mos_plan_start_due (cron every 10 min, and right after a month confirm) runs
-- the sweep, so a slot that frees as the 24-hour window rolls is filled within
-- ten minutes.
-- ============================================================================

BEGIN;

-- ------------------------------------------------------------ the dispatcher
CREATE OR REPLACE FUNCTION public.mos_task_dispatch(p_task_id uuid, p_notify boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_task    public.workflow_role_tasks%ROWTYPE;
  v_rule    public.mos_step_rules%ROWTYPE;
  v_bucket  text;
  v_units   numeric;
  v_allow   numeric;
  v_now     timestamptz := now();
  v_pick    uuid;
  v_due     timestamptz;
  v_leave_h numeric;
  v_holders int;
  v_label   text;
BEGIN
  SELECT * INTO v_task FROM public.workflow_role_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR v_task.status <> 'open' THEN RETURN 'not_open'; END IF;
  IF v_task.assignee_user_id IS NOT NULL AND v_task.assigned_at IS NOT NULL THEN
    RETURN 'already_assigned';
  END IF;

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
  IF NOT EXISTS (SELECT 1 FROM public.roles r WHERE r.key = 'mos_' || v_task.role_key) THEN
    RAISE EXCEPTION 'MOS:ROLE_NOT_FOUND mos_% (task %)', v_task.role_key, p_task_id
      USING ERRCODE = 'no_data_found';
  END IF;

  v_bucket := public.mos_subject_bucket(v_task.subject_table, v_task.subject_id);
  v_units  := public.mos_task_units(v_task.subject_table, v_task.subject_id);
  SELECT * INTO v_rule FROM public.mos_step_rules WHERE step_key = v_task.step_key;
  -- A step with no rule row (legacy video / publishing steps) keeps the
  -- pre-2026-09-17 allowance of 24 hours and is not capped.
  v_allow := COALESCE(v_rule.allowance_hours, 24);

  IF public.mos_subject_inactive(v_task.subject_table, v_task.subject_id) THEN
    UPDATE public.workflow_role_tasks
       SET bucket = v_bucket, units = v_units, assignee_user_id = NULL, assigned_at = NULL,
           due_at = NULL, waiting_since = COALESCE(waiting_since, v_now), waiting_reason = 'inactive'
     WHERE id = p_task_id;
    RETURN 'waiting';
  END IF;

  SELECT h.uid INTO v_pick
    FROM public.mos_role_routine_holders(v_task.role_key) h(uid)
   WHERE v_rule.capacity_key IS NULL
      OR public.mos_capacity_used(h.uid, v_rule.capacity_key, v_now) + v_units <= v_rule.daily_limit
      -- a subject wider than the limit is handed out alone into an empty window
      OR public.mos_capacity_used(h.uid, v_rule.capacity_key, v_now) = 0
   ORDER BY (SELECT max(t.assigned_at) FROM public.workflow_role_tasks t
              WHERE t.assignee_user_id = h.uid AND t.role_key = v_task.role_key) ASC NULLS FIRST,
            h.uid
   LIMIT 1;

  IF v_pick IS NULL THEN
    SELECT count(*) INTO v_holders FROM public.mos_role_routine_holders(v_task.role_key);
    UPDATE public.workflow_role_tasks
       SET bucket = v_bucket, units = v_units, assignee_user_id = NULL, assigned_at = NULL,
           due_at = NULL, waiting_since = COALESCE(waiting_since, v_now),
           waiting_reason = CASE WHEN v_holders = 0 THEN 'no_holder' ELSE 'capacity' END
     WHERE id = p_task_id;
    IF v_holders = 0 THEN
      RAISE WARNING 'MOS:TASK_WAITING_NO_HOLDER % (role=%) — no active holder takes routine % work',
        p_task_id, v_task.role_key, v_task.role_key;
    END IF;
    RETURN 'waiting';
  END IF;

  v_due := v_now + v_allow * interval '1 hour';
  SELECT COALESCE(sum(EXTRACT(EPOCH FROM (LEAST(l.end_at, v_due) - GREATEST(l.start_at, v_now))) / 3600.0), 0)
    INTO v_leave_h
    FROM public.mos_leaves l
   WHERE l.user_id = v_pick AND l.status = 'approved'
     AND l.start_at < v_due AND l.end_at > v_now;
  IF v_leave_h > 0 THEN v_due := v_due + (v_leave_h * interval '1 hour'); END IF;

  UPDATE public.workflow_role_tasks
     SET bucket = v_bucket, units = v_units, assignee_user_id = v_pick, assigned_at = v_now,
         due_at = v_due, waiting_since = NULL, waiting_reason = NULL
   WHERE id = p_task_id;

  -- A task handed out by the sweep (not inline in a user's own action, which
  -- the API notifies) must tell its new owner. A failed notification must not
  -- undo the assignment: logged loudly, the hand-out stands.
  IF p_notify THEN
    v_label := COALESCE(
      (SELECT COALESCE(NULLIF(btrim(c.title), ''), c.ref) FROM public.mos_content c
        WHERE v_task.subject_table = 'mos_content' AND c.id = v_task.subject_id),
      (SELECT string_agg(COALESCE(NULLIF(btrim(c.title), ''), c.ref), ' · ' ORDER BY c.row_order NULLS LAST)
         FROM public.mos_content c
        WHERE v_task.subject_table = 'mos_content_rows' AND c.row_id = v_task.subject_id
          AND c.archived_at IS NULL),
      '');
    BEGIN
      PERFORM public.notify_emit('marketing', 'task_assigned', ARRAY[]::text[], ARRAY[v_pick],
        'فُتحت لك مهمة', 'A task was assigned to you',
        format('«%s» بانتظار خطوتك.', v_label), v_label,
        '/m/my-work', NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'MOS:DISPATCH_NOTIFY_FAILED task % user %: % %', p_task_id, v_pick, SQLSTATE, SQLERRM;
    END;
  END IF;

  RETURN 'assigned';
END $$;

-- Does any routine holder of this role have room for this many units now?
CREATE OR REPLACE FUNCTION public.mos_role_has_room(p_role_key text, p_step_key text, p_units numeric)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.mos_role_routine_holders(p_role_key) h(uid)
      LEFT JOIN public.mos_step_rules sr ON sr.step_key = p_step_key
     WHERE sr.capacity_key IS NULL
        OR public.mos_capacity_used(h.uid, sr.capacity_key, now()) + p_units <= sr.daily_limit
        OR public.mos_capacity_used(h.uid, sr.capacity_key, now()) = 0)
$$;

-- ----------------------------------------------- the two old entry points
-- The legacy placer is now a thin alias: every caller (workflow_role_path_start,
-- workflow_advance_role_path, content_revise) reaches the one dispatcher.
CREATE OR REPLACE FUNCTION public.mos_perf_place_open_task(p_task_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM public.mos_task_dispatch(p_task_id, false);
END $$;

-- Links the task to its month booking (so the planned date stays visible next
-- to the real deadline) and hands out through the dispatcher. It no longer
-- copies the planner's named person or an end-of-day deadline.
CREATE OR REPLACE FUNCTION public.mos_plan_consume_reservation(p_task_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_task   public.workflow_role_tasks%ROWTYPE;
  v_res    public.mos_task_reservations%ROWTYPE;
  v_key    text;
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
    SELECT r.row_key INTO v_key FROM public.mos_content_rows r WHERE r.id = v_task.subject_id;
  ELSE
    SELECT cp.content_key INTO v_key FROM public.mos_content_plan cp WHERE cp.content_id = v_task.subject_id;
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
    RETURN NULL;   -- the caller then runs mos_perf_place_open_task → dispatcher
  END IF;

  UPDATE public.mos_task_reservations
     SET status           = 'consumed',
         consumed_task_id = v_task.id,
         content_id       = CASE WHEN v_is_row THEN content_id ELSE v_task.subject_id END,
         row_id           = CASE WHEN v_is_row THEN v_task.subject_id ELSE row_id END,
         updated_at       = now()
   WHERE id = v_res.id;

  UPDATE public.workflow_role_tasks
     SET scheduled_start = v_res.planned_start,
         scheduled_end   = v_res.planned_end,
         effort_days     = GREATEST(v_res.weight, 0.5),
         reservation_id  = v_res.id,
         bucket          = COALESCE(bucket, v_res.bucket)
   WHERE id = v_task.id;

  PERFORM public.mos_task_dispatch(v_task.id, false);

  RETURN v_res.id;
END $$;

-- ------------------------------------------------------------------ sweep
-- Gives back work held by someone who lost the role, then hands out every
-- unassigned open task in publish-date order.
CREATE OR REPLACE FUNCTION public.mos_dispatch_sweep()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  r          record;
  v_released int := 0;
  v_assigned int := 0;
  v_waiting  int := 0;
  v_out      text;
BEGIN
  PERFORM public.mos_ledger_lock();

  FOR r IN
    SELECT t.id FROM public.workflow_role_tasks t
     WHERE t.status = 'open' AND t.assignee_user_id IS NOT NULL
       AND t.subject_table IN ('mos_content', 'mos_content_rows')
       AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id)
       AND NOT public.mos_user_holds_role(t.assignee_user_id, t.role_key)
  LOOP
    UPDATE public.workflow_role_tasks
       SET assignee_user_id = NULL, assigned_at = NULL, due_at = NULL
     WHERE id = r.id;
    v_released := v_released + 1;
  END LOOP;

  FOR r IN
    SELECT t.id FROM public.workflow_role_tasks t
     WHERE t.status = 'open' AND t.assignee_user_id IS NULL
       AND t.subject_table IN ('mos_content', 'mos_content_rows')
       AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id)
     ORDER BY public.mos_subject_publish_at(t.subject_table, t.subject_id) ASC NULLS LAST,
              COALESCE(t.waiting_since, t.created_at), t.id
  LOOP
    v_out := public.mos_task_dispatch(r.id, true);
    IF v_out = 'assigned' THEN v_assigned := v_assigned + 1;
    ELSIF v_out = 'waiting' THEN v_waiting := v_waiting + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('released', v_released, 'assigned', v_assigned, 'waiting', v_waiting);
END $$;

-- ------------------------------------------------------------- start_due
-- Confirmed work starts as soon as its first step's role has room — not on the
-- planner's date — in publish-date order. Rows and single items compete in one
-- queue. Refresh cycles keep their own date (a refresh is timed by the running
-- ad, not by capacity).
CREATE OR REPLACE FUNCTION public.mos_plan_start_due()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  v_first   jsonb;
  v_sweep   jsonb;
BEGIN
  PERFORM public.mos_ledger_lock();

  -- (0) Hand out what is already open first: in-flight work outranks new starts.
  v_sweep := public.mos_dispatch_sweep();

  -- (1) New starts, rows and loose items together, earliest publish first.
  FOR r IN
    SELECT q.st, q.id, q.ver
      FROM (
        SELECT 'mos_content_rows'::text AS st, rw.id, rw.workflow_version_id AS ver
          FROM public.mos_content_rows rw
         WHERE EXISTS (SELECT 1 FROM public.mos_task_reservations tr
                        WHERE tr.row_id = rw.id AND tr.status IN ('reserved','stale'))
           AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                            WHERE t.subject_table = 'mos_content_rows' AND t.subject_id = rw.id)
        UNION ALL
        SELECT 'mos_content', c.id, c.workflow_version_id
          FROM public.mos_content_plan cp
          JOIN public.mos_content c ON c.id = cp.content_id AND c.row_id IS NULL
         WHERE cp.status = 'planned'
           AND cp.production_start IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                            WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id)
      ) q
     WHERE NOT public.mos_subject_inactive(q.st, q.id)
     ORDER BY public.mos_subject_publish_at(q.st, q.id) ASC NULLS LAST, q.id
  LOOP
    SELECT v.definition->'metadata'->'steps'->0 INTO v_first
      FROM public.workflow_versions v WHERE v.id = r.ver;
    IF v_first IS NULL THEN
      RAISE WARNING 'MOS:START_NO_WORKFLOW % % has no pinned workflow steps', r.st, r.id;
      CONTINUE;
    END IF;
    -- No room for THIS one: a smaller later item may still fit, so keep looking.
    IF NOT public.mos_role_has_room(v_first->>'role_key', v_first->>'key',
                                    public.mos_task_units(r.st, r.id)) THEN
      CONTINUE;
    END IF;

    PERFORM public.workflow_role_path_start(r.st, r.id);
    IF r.st = 'mos_content_rows' THEN
      UPDATE public.mos_content_plan cp
         SET status = 'in_production'
       WHERE cp.status = 'planned'
         AND cp.content_id IN (SELECT c.id FROM public.mos_content c WHERE c.row_id = r.id);
      v_rows := v_rows + 1;
    ELSE
      UPDATE public.mos_content_plan SET status = 'in_production' WHERE content_id = r.id;
    END IF;
    v_started := v_started + 1;
  END LOOP;

  UPDATE public.mos_content_plan cp
     SET status = 'in_production'
   WHERE cp.status = 'planned'
     AND (EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                   WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id)
       OR EXISTS (SELECT 1 FROM public.mos_content c
                    JOIN public.workflow_role_tasks t
                      ON t.subject_table = 'mos_content_rows' AND t.subject_id = c.row_id
                   WHERE c.id = cp.content_id));

  -- (2) Refresh cycles — unchanged.
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
                            'shells_created', v_shells, 'cycles_started', v_cycles,
                            'dispatch', v_sweep);
END $$;

-- ------------------------------------------------------- existing tasks
-- Tasks handed out before today carry no receipt time. Their opening time IS
-- when they were received, so the rolling window and the deadline rule can
-- count them. Open ones get the rule's deadline.
UPDATE public.workflow_role_tasks t
   SET assigned_at = t.opened_at,
       units       = public.mos_task_units(t.subject_table, t.subject_id)
 WHERE t.assignee_user_id IS NOT NULL AND t.assigned_at IS NULL
   AND t.subject_table IN ('mos_content', 'mos_content_rows')
   AND t.opened_at IS NOT NULL
   AND (t.status = 'open' OR t.opened_at > now() - interval '2 days');

UPDATE public.workflow_role_tasks t
   SET due_at = t.assigned_at + sr.allowance_hours * interval '1 hour'
  FROM public.mos_step_rules sr
 WHERE sr.step_key = t.step_key
   AND t.status = 'open' AND t.assigned_at IS NOT NULL
   AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id);

-- ------------------------------------------------------------------ grants
REVOKE ALL ON FUNCTION public.mos_task_dispatch(uuid, boolean)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_role_has_room(text, text, numeric)      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_dispatch_sweep()                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mos_plan_start_due()                        FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mos_dispatch_sweep() TO service_role;
GRANT EXECUTE ON FUNCTION public.mos_plan_start_due() TO service_role;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('mos_task_dispatch', 'mos_role_has_room', 'mos_dispatch_sweep',
                       'mos_plan_start_due', 'mos_task_rules_audit', 'mos_capacity_used',
                       'mos_role_routine_holders', 'mos_user_holds_role', 'mos_task_units',
                       'mos_subject_publish_at', 'mos_subject_inactive')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR pg_get_functiondef(p.oid) ~ '''40001''|''40P01''|serialization_failure|deadlock_detected');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'MOS:DISPATCH_GUARD_FAILED — %', v_bad;
  END IF;
END $$;

COMMIT;
