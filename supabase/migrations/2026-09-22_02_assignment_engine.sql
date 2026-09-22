-- ============================================================================
-- Plan-driven task assignment — 2/5: THE ENGINE.
-- 2026-09-22. Plan v9 §1 (chain, deadlines, risk), §3 (one process decides),
-- §4 (bands, offers, start-early) + 07-decisions.md (D2, D6, D7, D12, D12b,
-- D15, D16, D17, D19).
--
-- One process decides assignment: `mos_refill`. Everything else only OPENS a
-- task and BINDS its booking (`mos_task_open`), or APPLIES a decision with no
-- admission policy of its own (`mos_task_assign_apply`). The rolling 24-hour
-- capacity counter is gone from every planned path (D2): the confirmed month
-- plan and the commit guard are the cap. `mos_capacity_used` survives ONLY for
-- tasks that carry no reservation (revisions, legacy), as OPEN units.
--
-- Backward compatible: every RPC the deployed API calls keeps its name and
-- signature (`workflow_role_path_start`, `mos_plan_start_due`,
-- `mos_dispatch_sweep`, `mos_plan_repair`, `mos_task_dispatch`).
-- No function here raises SQLSTATE 40001/40P01 (WS409 for conflicts).
-- ============================================================================

BEGIN;

-- ── helpers ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_planning_num(p_key text, p_default numeric)
 RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((public.mos_planning_cfg() ->> p_key)::numeric, p_default);
$$;

CREATE OR REPLACE FUNCTION public.mos_step_target_hours(p_step_key text)
 RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT sr.target_hours FROM public.mos_step_rules sr WHERE sr.step_key = p_step_key;
$$;

CREATE OR REPLACE FUNCTION public.mos_step_sort(p_step_key text)
 RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT sr.sort_order FROM public.mos_step_rules sr WHERE sr.step_key = p_step_key), 1000);
$$;

/** Riyadh local midnight of a civil day, as an instant. */
CREATE OR REPLACE FUNCTION public.mos_day_start(p_day date)
 RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_day::timestamp AT TIME ZONE 'Asia/Riyadh');
$$;

/**
 * The subject's LIVE reservation for a step (reserved/stale/bound/consumed).
 * Keyed by row_id for rows, content_id for content — the same keys the
 * uniqueness index enforces, so there is at most one.
 */
CREATE OR REPLACE FUNCTION public.mos_subject_reservation(p_subject_table text, p_subject_id uuid, p_step_key text)
 RETURNS public.mos_task_reservations LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT r.* FROM public.mos_task_reservations r
   WHERE r.step_key = p_step_key
     AND r.status IN ('reserved','stale','bound','consumed')
     AND ((p_subject_table = 'mos_content_rows' AND r.row_id = p_subject_id)
       OR (p_subject_table = 'mos_content'      AND r.content_id = p_subject_id))
   LIMIT 1;
$$;

-- ── §1a the planned chain: ONE implementation ───────────────────────────────
--   handoff_1  = booked_day_1 00:00 Riyadh
--   cand_k     = mos_work_due_at(handoff_{k-1}, target_{k-1})   (target NULL → 0 h)
--   handoff_k  = GREATEST(booked_day_k 00:00, cand_k)
--   plan_due_k = mos_work_due_at(handoff_k, allowance_k)
-- Booked days come from the subject's LIVE reservations (rows by row_id,
-- content by content_id). Steps with no reservation are not in the chain.
CREATE OR REPLACE FUNCTION public.mos_plan_chain(p_subject_table text, p_subject_id uuid)
 RETURNS TABLE(step_key text, sort_order integer, booked_day date, target_hours numeric,
               allowance_hours numeric, plan_handoff_at timestamptz, plan_due_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  r        record;
  v_prev_h timestamptz := NULL;
  v_prev_t numeric := NULL;
  v_cand   timestamptz;
BEGIN
  FOR r IN
    SELECT res.step_key, public.mos_step_sort(res.step_key) AS so, res.planned_start,
           public.mos_step_target_hours(res.step_key) AS tgt,
           COALESCE(sr.allowance_hours, 24) AS allow
      FROM public.mos_task_reservations res
      LEFT JOIN public.mos_step_rules sr ON sr.step_key = res.step_key
     WHERE res.status IN ('reserved','stale','bound','consumed')
       AND ((p_subject_table = 'mos_content_rows' AND res.row_id = p_subject_id)
         OR (p_subject_table = 'mos_content'      AND res.content_id = p_subject_id))
     ORDER BY public.mos_step_sort(res.step_key), res.planned_start
  LOOP
    IF v_prev_h IS NULL THEN
      plan_handoff_at := public.mos_day_start(r.planned_start);
    ELSE
      v_cand := CASE WHEN v_prev_t IS NULL THEN v_prev_h
                     ELSE public.mos_work_due_at(v_prev_h, v_prev_t) END;
      plan_handoff_at := GREATEST(public.mos_day_start(r.planned_start), v_cand);
    END IF;
    step_key := r.step_key; sort_order := r.so; booked_day := r.planned_start;
    target_hours := r.tgt; allowance_hours := r.allow;
    plan_due_at := public.mos_work_due_at(plan_handoff_at, r.allow);
    v_prev_h := plan_handoff_at; v_prev_t := r.tgt;
    RETURN NEXT;
  END LOOP;
END $$;

-- ── §4b readiness — ONE closed vocabulary ───────────────────────────────────
-- blocked | inactive | awaiting:<pred_step_key> | reserved_future | ready
-- A task exists only because the engine opened it after its predecessor (a
-- revision CLOSES the subject's open task), so a task's readiness is its own
-- state. A reservation-only item is executable only as the subject's FIRST
-- step when the subject has no task yet; later steps wait for the engine.
CREATE OR REPLACE FUNCTION public.mos_item_readiness(p_task_id uuid, p_reservation_id uuid)
 RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  t     public.workflow_role_tasks%ROWTYPE;
  r     public.mos_task_reservations%ROWTYPE;
  v_st  text; v_sid uuid; v_first text; v_pred text; v_day date;
BEGIN
  IF p_task_id IS NOT NULL THEN
    SELECT * INTO t FROM public.workflow_role_tasks WHERE id = p_task_id;
    IF NOT FOUND THEN RETURN 'inactive'; END IF;
    IF t.blocked THEN RETURN 'blocked'; END IF;
    IF public.mos_subject_inactive(t.subject_table, t.subject_id) THEN RETURN 'inactive'; END IF;
    IF t.scheduled_start IS NOT NULL AND t.scheduled_start > public.mos_perf_today() THEN RETURN 'reserved_future'; END IF;
    RETURN 'ready';
  END IF;

  SELECT * INTO r FROM public.mos_task_reservations WHERE id = p_reservation_id;
  IF NOT FOUND THEN RETURN 'inactive'; END IF;
  v_st  := CASE WHEN r.row_id IS NOT NULL THEN 'mos_content_rows' ELSE 'mos_content' END;
  v_sid := COALESCE(r.row_id, r.content_id);
  IF v_sid IS NULL THEN RETURN 'awaiting:materialise'; END IF;    -- deferred paid shell
  IF public.mos_subject_inactive(v_st, v_sid) THEN RETURN 'inactive'; END IF;

  SELECT e.elem ->> 'key' INTO v_first
    FROM public.workflow_versions v,
         LATERAL jsonb_array_elements(v.definition -> 'metadata' -> 'steps') WITH ORDINALITY e(elem, ord)
   WHERE v.id = public.mos_subject_version_id(v_st, v_sid)
   ORDER BY e.ord LIMIT 1;

  IF r.step_key IS DISTINCT FROM v_first
     OR EXISTS (SELECT 1 FROM public.workflow_role_tasks x
                 WHERE x.subject_table = v_st AND x.subject_id = v_sid) THEN
    SELECT prev.elem ->> 'key' INTO v_pred
      FROM public.workflow_versions v,
           LATERAL jsonb_array_elements(v.definition -> 'metadata' -> 'steps') WITH ORDINALITY cur(elem, ord),
           LATERAL jsonb_array_elements(v.definition -> 'metadata' -> 'steps') WITH ORDINALITY prev(elem, ord)
     WHERE v.id = public.mos_subject_version_id(v_st, v_sid)
       AND cur.elem ->> 'key' = r.step_key AND prev.ord = cur.ord - 1
     LIMIT 1;
    RETURN 'awaiting:' || COALESCE(v_pred, 'previous');
  END IF;

  v_day := r.planned_start;
  IF v_day > public.mos_perf_today() THEN RETURN 'reserved_future'; END IF;
  RETURN 'ready';
END $$;

CREATE OR REPLACE FUNCTION public.mos_item_executable(p_task_id uuid, p_reservation_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT public.mos_item_readiness(p_task_id, p_reservation_id) IN ('ready','reserved_future');
$$;

-- The vocabulary is closed. Anything else is a bug, never "executable".
CREATE OR REPLACE FUNCTION public.mos_readiness_is_known(p_readiness text)
 RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_readiness IN ('blocked','inactive','reserved_future','ready')
      OR p_readiness LIKE 'awaiting:%';
$$;

-- ── §4e the one ordering ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_task_planned_day(p_task_id uuid)
 RETURNS date LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    t.scheduled_start,
    (SELECT min(r.planned_start) FROM public.mos_task_reservations r
      WHERE r.status IN ('reserved','stale','bound','consumed')
        AND ((t.subject_table = 'mos_content_rows' AND r.row_id = t.subject_id)
          OR (t.subject_table = 'mos_content'      AND r.content_id = t.subject_id))),
    (public.mos_subject_publish_at(t.subject_table, t.subject_id) AT TIME ZONE 'Asia/Riyadh')::date)
    FROM public.workflow_role_tasks t WHERE t.id = p_task_id;
$$;

-- ── §3a open + bind. Never assigns. ─────────────────────────────────────────
-- Binding a virtual (cycle-keyed) reservation stamps content_id/row_id on it,
-- exactly as the consume path did — dropping that would leave paid bookings on
-- their cycle key and break the re-plan carry-forward (3/5).
CREATE OR REPLACE FUNCTION public.mos_plan_consume_reservation(p_task_id uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_task   public.workflow_role_tasks%ROWTYPE;
  v_res    public.mos_task_reservations%ROWTYPE;
  v_key    text;
  v_is_row boolean;
  v_chain  record;
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

  -- The consume-search stays on reserved/stale: a `bound` reservation can never
  -- be bound twice (§9 E-LEDGER-6).
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
   ORDER BY (CASE WHEN v_is_row THEN r.row_id IS NOT NULL ELSE r.content_id IS NOT NULL END) DESC,
            r.planned_start
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE public.mos_task_reservations
     SET status           = 'bound',
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
         bucket          = COALESCE(bucket, v_res.bucket),
         units           = COALESCE(units, public.mos_task_units(v_task.subject_table, v_task.subject_id)),
         waiting_since   = NULL, waiting_reason = NULL
   WHERE id = v_task.id;

  -- planned handoff + deadline from the ONE chain implementation
  SELECT c.plan_handoff_at, c.plan_due_at INTO v_chain
    FROM public.mos_plan_chain(v_task.subject_table, v_task.subject_id) c
   WHERE c.step_key = v_task.step_key LIMIT 1;
  IF FOUND THEN
    UPDATE public.workflow_role_tasks
       SET plan_handoff_at = v_chain.plan_handoff_at, plan_due_at = v_chain.plan_due_at
     WHERE id = v_task.id;
  END IF;

  RETURN v_res.id;
END $$;

-- Opens a step's task for a subject and binds its booking. Internal.
CREATE OR REPLACE FUNCTION public.mos_task_open_step(p_subject_table text, p_subject_id uuid,
                                                     p_version_id uuid, p_step jsonb, p_round integer)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_new uuid;
BEGIN
  INSERT INTO public.workflow_role_tasks
    (subject_table, subject_id, workflow_version_id, step_key, role_key, round, due_at,
     bucket, units)
  VALUES
    (p_subject_table, p_subject_id, p_version_id, p_step ->> 'key', p_step ->> 'role_key', p_round, NULL,
     public.mos_subject_bucket(p_subject_table, p_subject_id),
     public.mos_task_units(p_subject_table, p_subject_id))
  RETURNING id INTO v_new;
  PERFORM public.mos_plan_consume_reservation(v_new);
  RETURN v_new;
END $$;

/** Opens the FIRST step of a subject (the sweep / path start). Never assigns. */
CREATE OR REPLACE FUNCTION public.mos_task_open(p_subject_table text, p_subject_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_steps jsonb; v_first jsonb; v_ver uuid; v_new uuid; v_found boolean;
BEGIN
  PERFORM public.mos_ledger_lock();
  IF p_subject_table NOT IN ('mos_content', 'mos_content_rows') THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table USING ERRCODE = 'feature_not_supported';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_role_tasks
              WHERE subject_table = p_subject_table AND subject_id = p_subject_id AND status = 'open') THEN
    RETURN jsonb_build_object('opened_task_id', NULL, 'already_open', true);
  END IF;
  IF p_subject_table = 'mos_content_rows' THEN
    SELECT true, r.workflow_version_id, v.definition->'metadata'->'steps' INTO v_found, v_ver, v_steps
      FROM public.mos_content_rows r LEFT JOIN public.workflow_versions v ON v.id = r.workflow_version_id
     WHERE r.id = p_subject_id;
  ELSE
    SELECT true, c.workflow_version_id, v.definition->'metadata'->'steps' INTO v_found, v_ver, v_steps
      FROM public.mos_content c LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
     WHERE c.id = p_subject_id;
  END IF;
  IF NOT COALESCE(v_found, false) THEN
    RAISE EXCEPTION 'MOS:SUBJECT_NOT_FOUND % %', p_subject_table, p_subject_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_steps IS NULL OR jsonb_typeof(v_steps) <> 'array' OR jsonb_array_length(v_steps) = 0 THEN
    RETURN jsonb_build_object('opened_task_id', NULL, 'already_open', false);
  END IF;
  v_first := v_steps -> 0;
  v_new := public.mos_task_open_step(p_subject_table, p_subject_id, v_ver, v_first, 1);
  RETURN jsonb_build_object('opened_task_id', v_new, 'already_open', false);
END $$;

-- ── §3a apply: NO admission policy ──────────────────────────────────────────
-- due_at = GREATEST(plan_due_at, receipt + allowance) + approved-leave hours.
CREATE OR REPLACE FUNCTION public.mos_task_assign_apply(p_task_id uuid, p_user_id uuid, p_notify boolean DEFAULT true)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_task    public.workflow_role_tasks%ROWTYPE;
  v_rule    public.mos_step_rules%ROWTYPE;
  v_now     timestamptz := clock_timestamp();
  v_due     timestamptz;
  v_leave_h numeric;
BEGIN
  SELECT * INTO v_task FROM public.workflow_role_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR v_task.status <> 'open' THEN
    RAISE EXCEPTION 'MOS:APPLY_INVARIANT task % is not open', p_task_id USING ERRCODE = 'WS409';
  END IF;
  IF v_task.assignee_user_id IS NOT NULL THEN
    IF v_task.assignee_user_id = p_user_id THEN RETURN 'already_assigned'; END IF;
    RAISE EXCEPTION 'MOS:APPLY_INVARIANT task % is already assigned', p_task_id USING ERRCODE = 'WS409';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'MOS:APPLY_INVARIANT no assignee for task %', p_task_id USING ERRCODE = 'WS409';
  END IF;

  SELECT * INTO v_rule FROM public.mos_step_rules WHERE step_key = v_task.step_key;
  v_due := GREATEST(COALESCE(v_task.plan_due_at, '-infinity'::timestamptz),
                    public.mos_work_due_at(v_now, COALESCE(v_rule.allowance_hours, 24)));

  SELECT COALESCE(sum(EXTRACT(EPOCH FROM (LEAST(l.end_at, v_due) - GREATEST(l.start_at, v_now))) / 3600.0), 0)
    INTO v_leave_h
    FROM public.mos_leaves l
   WHERE l.user_id = p_user_id AND l.status = 'approved' AND l.start_at < v_due AND l.end_at > v_now;
  IF v_leave_h > 0 THEN v_due := v_due + (v_leave_h * interval '1 hour'); END IF;

  UPDATE public.workflow_role_tasks
     SET assignee_user_id = p_user_id, assigned_at = v_now, due_at = v_due,
         bucket = COALESCE(bucket, public.mos_subject_bucket(subject_table, subject_id)),
         units  = COALESCE(units,  public.mos_task_units(subject_table, subject_id)),
         offered_to_user_id = NULL, offered_at = NULL,
         waiting_since = NULL, waiting_reason = NULL,
         handoff_slip = CASE WHEN plan_handoff_at IS NULL THEN NULL ELSE v_now - plan_handoff_at END,
         updated_at = v_now
   WHERE id = p_task_id;

  -- the exactly-once transfer between ledger arms (§3b)
  UPDATE public.mos_task_reservations
     SET status = 'consumed', updated_at = v_now
   WHERE consumed_task_id = p_task_id AND status = 'bound';

  IF p_notify THEN PERFORM public.mos_task_notify_assigned(p_task_id); END IF;
  RETURN 'assigned';
END $$;

/** Unassign while open: the booking returns to the reservation arm (Band C). */
CREATE OR REPLACE FUNCTION public.mos_task_release(p_task_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  UPDATE public.workflow_role_tasks
     SET assignee_user_id = NULL, assigned_at = NULL, due_at = NULL, handoff_slip = NULL,
         offered_to_user_id = NULL, offered_at = NULL, late_flag = false, updated_at = now()
   WHERE id = p_task_id AND status = 'open';
  UPDATE public.mos_task_reservations
     SET status = 'bound', updated_at = now()
   WHERE consumed_task_id = p_task_id AND status = 'consumed';
END $$;

-- ── §4c the offer eligibility predicate (e1–e8) ─────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_capacity_key_of(p_step_key text)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT sr.capacity_key FROM public.mos_step_rules sr WHERE sr.step_key = p_step_key;
$$;

/** e8: no open, non-blocked ASSIGNED task of this capacity key (reviews never count). */
CREATE OR REPLACE FUNCTION public.mos_person_idle(p_user_id uuid, p_capacity_key text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.workflow_role_tasks a
      JOIN public.mos_step_rules sr ON sr.step_key = a.step_key
     WHERE a.status = 'open' AND a.assignee_user_id = p_user_id AND a.blocked IS NOT TRUE
       AND sr.capacity_key = p_capacity_key);
$$;

/**
 * A person's future planned items of one capacity key, both kinds:
 * bound-unassigned tasks (planned to them) and first-step reservations with
 * no task yet. `executable` uses the closed readiness vocabulary.
 */
CREATE OR REPLACE FUNCTION public.mos_person_future_items(p_user_id uuid, p_capacity_key text, p_horizon_days integer)
 RETURNS TABLE(kind text, task_id uuid, reservation_id uuid, subject_table text, subject_id uuid,
               step_key text, role_key text, planned_day date, readiness text, executable boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH today AS (SELECT public.mos_perf_today() AS d)
  SELECT 'task', t.id, t.reservation_id, t.subject_table, t.subject_id, t.step_key, t.role_key,
         t.scheduled_start, public.mos_item_readiness(t.id, NULL),
         public.mos_item_executable(t.id, NULL)
    FROM public.workflow_role_tasks t
    JOIN public.mos_task_reservations r ON r.consumed_task_id = t.id AND r.status = 'bound'
    JOIN public.mos_step_rules sr ON sr.step_key = t.step_key, today
   WHERE t.status = 'open' AND t.assignee_user_id IS NULL
     AND r.assignee_user_id = p_user_id AND sr.capacity_key = p_capacity_key
     AND t.scheduled_start > today.d AND t.scheduled_start <= today.d + p_horizon_days
  UNION ALL
  SELECT 'reservation', NULL, r.id,
         CASE WHEN r.row_id IS NOT NULL THEN 'mos_content_rows' ELSE 'mos_content' END,
         COALESCE(r.row_id, r.content_id), r.step_key, r.role_key,
         r.planned_start, public.mos_item_readiness(NULL, r.id),
         public.mos_item_executable(NULL, r.id)
    FROM public.mos_task_reservations r
    JOIN public.mos_step_rules sr ON sr.step_key = r.step_key, today
   WHERE r.status = 'reserved' AND r.assignee_user_id = p_user_id AND sr.capacity_key = p_capacity_key
     AND COALESCE(r.row_id, r.content_id) IS NOT NULL
     AND r.planned_start > today.d AND r.planned_start <= today.d + p_horizon_days
     AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks x
                      WHERE x.subject_table = CASE WHEN r.row_id IS NOT NULL THEN 'mos_content_rows' ELSE 'mos_content' END
                        AND x.subject_id = COALESCE(r.row_id, r.content_id));
$$;

CREATE OR REPLACE FUNCTION public.mos_offer_eligible(p_task_id uuid, p_user_id uuid)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  t public.workflow_role_tasks%ROWTYPE; r public.mos_task_reservations%ROWTYPE;
  v_cap text; v_h int;
BEGIN
  SELECT * INTO t FROM public.workflow_role_tasks WHERE id = p_task_id;
  IF NOT FOUND OR t.status <> 'open' OR t.assignee_user_id IS NOT NULL
     OR t.offered_to_user_id IS DISTINCT FROM p_user_id THEN RETURN false; END IF;             -- e1
  IF public.mos_subject_inactive(t.subject_table, t.subject_id) THEN RETURN false; END IF;      -- e2
  SELECT * INTO r FROM public.mos_task_reservations WHERE consumed_task_id = t.id AND status = 'bound';
  IF NOT FOUND THEN RETURN false; END IF;                                                       -- e3
  IF NOT public.mos_item_executable(t.id, NULL) THEN RETURN false; END IF;                     -- e4
  IF t.scheduled_start IS NULL OR t.scheduled_start <= public.mos_perf_today() THEN RETURN false; END IF; -- e5
  IF p_user_id NOT IN (SELECT public.mos_role_routine_holders(t.role_key)) THEN RETURN false; END IF;      -- e6
  IF public.mos_on_leave(p_user_id, t.scheduled_start) THEN RETURN false; END IF;
  v_cap := public.mos_capacity_key_of(t.step_key);
  IF v_cap IS NULL THEN RETURN false; END IF;
  v_h := public.mos_planning_num('band_c_horizon_days', 14)::int;
  IF EXISTS (SELECT 1 FROM public.mos_person_future_items(p_user_id, v_cap, v_h) f               -- e7
              WHERE f.executable AND f.planned_day < t.scheduled_start) THEN RETURN false; END IF;
  IF NOT public.mos_person_idle(p_user_id, v_cap) THEN RETURN false; END IF;                   -- e8 (D12)
  RETURN true;
END $$;

-- ── refill re-entrancy ──────────────────────────────────────────────────────
-- Openers request a refill; if one is already running in this transaction the
-- request is queued (`mos.refill_again`) and drained by the running pass.
CREATE OR REPLACE FUNCTION public.mos_refill_request(p_roles text[] DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF COALESCE(current_setting('mos.in_refill', true), '') = '1' THEN
    PERFORM set_config('mos.refill_again', '1', true);
    RETURN;
  END IF;
  PERFORM public.mos_refill(p_roles);
END $$;

/** Holder pick for a task: planned assignee if valid, else the least-loaded routine holder. */
CREATE OR REPLACE FUNCTION public.mos_pick_holder(p_task_id uuid)
 RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  t public.workflow_role_tasks%ROWTYPE; v_planned uuid; v_cap text; v_pick uuid;
BEGIN
  SELECT * INTO t FROM public.workflow_role_tasks WHERE id = p_task_id;
  SELECT r.assignee_user_id INTO v_planned FROM public.mos_task_reservations r
   WHERE r.consumed_task_id = t.id AND r.status = 'bound' LIMIT 1;
  IF v_planned IS NOT NULL
     AND v_planned IN (SELECT public.mos_role_routine_holders(t.role_key))
     AND NOT public.mos_on_leave(v_planned, public.mos_perf_today()) THEN
    RETURN v_planned;
  END IF;
  v_cap := public.mos_capacity_key_of(t.step_key);
  SELECT h.uid INTO v_pick
    FROM public.mos_role_routine_holders(t.role_key) h(uid)
   WHERE NOT public.mos_on_leave(h.uid, public.mos_perf_today())
   ORDER BY (SELECT COALESCE(sum(COALESCE(a.units, 1)), 0)
               FROM public.workflow_role_tasks a
               LEFT JOIN public.mos_step_rules sr ON sr.step_key = a.step_key
              WHERE a.status = 'open' AND a.assignee_user_id = h.uid
                AND (v_cap IS NULL OR sr.capacity_key = v_cap)) ASC,
            (SELECT max(a.assigned_at) FROM public.workflow_role_tasks a
              WHERE a.assignee_user_id = h.uid AND a.role_key = t.role_key) ASC NULLS FIRST,
            h.uid
   LIMIT 1;
  RETURN v_pick;
END $$;

-- ── §4d THE ONE DECIDER ─────────────────────────────────────────────────────
-- Order (v6): strays → mandatory → tasks without reservations → reconcile
-- offers on the post-assignment state → idle test → early batch. Nothing
-- assigns after the early batch, so no trailing reconciliation is needed; a
-- queued `refill_again` repeats the whole order.
CREATE OR REPLACE FUNCTION public.mos_refill(p_roles text[] DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  r          record;
  p          record;
  f          record;
  v_today    date := public.mos_perf_today();
  v_working  boolean := public.mos_is_working_day(public.mos_perf_today());
  v_released int := 0; v_assigned int := 0; v_unplanned int := 0; v_withdrawn int := 0;
  v_offered  int := 0; v_waiting int := 0; v_passes int := 0;
  v_pick     uuid; v_cap text; v_limit int; v_units numeric; v_open numeric;
  v_day      date; v_new uuid; v_h int;
BEGIN
  PERFORM public.mos_ledger_lock();
  PERFORM set_config('mos.in_refill', '1', true);
  v_h := public.mos_planning_num('band_c_horizon_days', 14)::int;

  LOOP
    v_passes := v_passes + 1;
    PERFORM set_config('mos.refill_again', '0', true);

    -- 0. strays: the assignee no longer holds the role → back to the reservation arm
    FOR r IN
      SELECT t.id FROM public.workflow_role_tasks t
       WHERE t.status = 'open' AND t.assignee_user_id IS NOT NULL
         AND t.subject_table IN ('mos_content','mos_content_rows')
         AND (p_roles IS NULL OR t.role_key = ANY (p_roles))
         AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id)
         AND NOT public.mos_user_holds_role(t.assignee_user_id, t.role_key)
    LOOP
      PERFORM public.mos_task_release(r.id);
      v_released := v_released + 1;
    END LOOP;

    IF v_working THEN
      -- 1. mandatory: planned work whose day has come. Not capacity-gated (D2).
      FOR r IN
        SELECT t.id, t.step_key, t.role_key
          FROM public.workflow_role_tasks t
         WHERE t.status = 'open' AND t.assignee_user_id IS NULL
           AND t.reservation_id IS NOT NULL
           AND t.subject_table IN ('mos_content','mos_content_rows')
           AND (p_roles IS NULL OR t.role_key = ANY (p_roles))
           AND COALESCE(t.scheduled_start, v_today) <= v_today
           AND public.mos_item_readiness(t.id, NULL) = 'ready'
         ORDER BY public.mos_task_planned_day(t.id) ASC NULLS LAST,
                  public.mos_subject_publish_at(t.subject_table, t.subject_id) ASC NULLS LAST,
                  public.mos_subject_publish_rank(t.subject_table, t.subject_id) ASC,
                  public.mos_step_sort(t.step_key), t.round, t.id
      LOOP
        v_pick := public.mos_pick_holder(r.id);
        IF v_pick IS NULL THEN
          UPDATE public.workflow_role_tasks
             SET waiting_since = COALESCE(waiting_since, now()), waiting_reason = 'no_holder'
           WHERE id = r.id;
          v_waiting := v_waiting + 1;
          CONTINUE;
        END IF;
        PERFORM public.mos_task_assign_apply(r.id, v_pick, true);
        v_assigned := v_assigned + 1;
      END LOOP;

      -- 2. tasks without reservations (revisions, legacy): open-units rule.
      --    OPERATIONAL (D12b): before early work is offered.
      FOR r IN
        SELECT t.id, t.step_key, t.role_key, COALESCE(t.units, public.mos_task_units(t.subject_table, t.subject_id)) AS units
          FROM public.workflow_role_tasks t
         WHERE t.status = 'open' AND t.assignee_user_id IS NULL
           AND t.reservation_id IS NULL
           AND t.subject_table IN ('mos_content','mos_content_rows')
           AND (p_roles IS NULL OR t.role_key = ANY (p_roles))
           AND public.mos_item_readiness(t.id, NULL) = 'ready'
         ORDER BY public.mos_task_planned_day(t.id) ASC NULLS LAST,
                  public.mos_subject_publish_at(t.subject_table, t.subject_id) ASC NULLS LAST,
                  public.mos_subject_publish_rank(t.subject_table, t.subject_id) ASC,
                  public.mos_step_sort(t.step_key), t.round, t.id
      LOOP
        v_cap := public.mos_capacity_key_of(r.step_key);
        SELECT sr.daily_limit INTO v_limit FROM public.mos_step_rules sr WHERE sr.step_key = r.step_key;
        SELECT h.uid INTO v_pick
          FROM public.mos_role_routine_holders(r.role_key) h(uid)
          CROSS JOIN LATERAL (
            SELECT COALESCE(sum(COALESCE(a.units, 1)), 0) AS open_units
              FROM public.workflow_role_tasks a
              LEFT JOIN public.mos_step_rules sr ON sr.step_key = a.step_key
             WHERE a.status = 'open' AND a.assignee_user_id = h.uid
               AND (v_cap IS NULL OR sr.capacity_key = v_cap)) x
         WHERE NOT public.mos_on_leave(h.uid, v_today)
           AND (v_cap IS NULL OR x.open_units = 0 OR x.open_units + r.units <= v_limit)
         ORDER BY x.open_units ASC, h.uid
         LIMIT 1;
        IF v_pick IS NULL THEN
          UPDATE public.workflow_role_tasks
             SET waiting_since = COALESCE(waiting_since, now()), waiting_reason = 'capacity'
           WHERE id = r.id;
          v_waiting := v_waiting + 1;
          CONTINUE;
        END IF;
        PERFORM public.mos_task_assign_apply(r.id, v_pick, true);
        v_unplanned := v_unplanned + 1;
      END LOOP;
    ELSE
      UPDATE public.workflow_role_tasks
         SET waiting_since = COALESCE(waiting_since, now()), waiting_reason = 'day_off'
       WHERE status = 'open' AND assignee_user_id IS NULL
         AND (p_roles IS NULL OR role_key = ANY (p_roles));
    END IF;

    -- 3. reconcile existing offers on the POST-assignment state (v6)
    FOR r IN
      SELECT t.id, t.offered_to_user_id AS uid
        FROM public.workflow_role_tasks t
       WHERE t.status = 'open' AND t.assignee_user_id IS NULL AND t.offered_to_user_id IS NOT NULL
         AND (p_roles IS NULL OR t.role_key = ANY (p_roles))
    LOOP
      IF NOT public.mos_offer_eligible(r.id, r.uid) THEN
        UPDATE public.workflow_role_tasks
           SET offered_to_user_id = NULL, offered_at = NULL, updated_at = now()
         WHERE id = r.id;
        v_withdrawn := v_withdrawn + 1;
      END IF;
    END LOOP;

    -- 4 + 5. idle test, then ONE future day's whole executable batch per (person, capacity key)
    IF v_working THEN
      FOR p IN
        SELECT DISTINCT h.uid, sr.capacity_key, sr.step_key
          FROM public.mos_step_rules sr
          JOIN LATERAL (SELECT DISTINCT s2.role_key
                          FROM public.mos_task_reservations s2
                         WHERE s2.step_key = sr.step_key) rk ON true
          JOIN public.mos_role_routine_holders(rk.role_key) h(uid) ON true
         WHERE sr.capacity_key IS NOT NULL
           AND (p_roles IS NULL OR rk.role_key = ANY (p_roles))
      LOOP
        CONTINUE WHEN NOT public.mos_person_idle(p.uid, p.capacity_key);
        CONTINUE WHEN EXISTS (SELECT 1 FROM public.workflow_role_tasks o
                                JOIN public.mos_step_rules s3 ON s3.step_key = o.step_key
                               WHERE o.status = 'open' AND o.assignee_user_id IS NULL
                                 AND o.offered_to_user_id = p.uid AND s3.capacity_key = p.capacity_key);
        SELECT min(fi.planned_day) INTO v_day
          FROM public.mos_person_future_items(p.uid, p.capacity_key, v_h) fi
         WHERE fi.executable;
        CONTINUE WHEN v_day IS NULL;
        FOR f IN
          SELECT * FROM public.mos_person_future_items(p.uid, p.capacity_key, v_h) fi
           WHERE fi.executable AND fi.planned_day = v_day
        LOOP
          v_new := f.task_id;
          IF v_new IS NULL THEN
            v_new := (public.mos_task_open(f.subject_table, f.subject_id) ->> 'opened_task_id')::uuid;
            CONTINUE WHEN v_new IS NULL;
          END IF;
          UPDATE public.workflow_role_tasks
             SET offered_to_user_id = p.uid, offered_at = now(), updated_at = now()
           WHERE id = v_new AND status = 'open' AND assignee_user_id IS NULL;
          IF FOUND THEN v_offered := v_offered + 1; END IF;
        END LOOP;
      END LOOP;
    END IF;

    EXIT WHEN COALESCE(current_setting('mos.refill_again', true), '0') <> '1' OR v_passes >= 5;
  END LOOP;

  PERFORM set_config('mos.in_refill', '0', true);
  RETURN jsonb_build_object('released', v_released, 'assigned', v_assigned, 'unplanned', v_unplanned,
                            'withdrawn', v_withdrawn, 'offered', v_offered, 'waiting', v_waiting,
                            'passes', v_passes, 'working_day', v_working);
END $$;

-- ── §4f start-early: the user path for Band B ───────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_task_start_early(p_task_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  t public.workflow_role_tasks%ROWTYPE; v_actor uuid := public.wassell_app_user_id(auth.uid());
  v_reason text;
BEGIN
  PERFORM public.mos_ledger_lock();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO t FROM public.workflow_role_tasks WHERE id = p_task_id FOR UPDATE;
  v_reason := CASE
    WHEN NOT FOUND OR t.status <> 'open' THEN 'not_open'
    WHEN t.assignee_user_id IS NOT NULL AND t.assignee_user_id <> v_actor THEN 'already_taken'
    WHEN t.assignee_user_id = v_actor THEN NULL
    WHEN t.offered_to_user_id IS DISTINCT FROM v_actor THEN 'not_offered'
    WHEN public.mos_subject_inactive(t.subject_table, t.subject_id) THEN 'subject_inactive'
    WHEN NOT EXISTS (SELECT 1 FROM public.mos_task_reservations r
                      WHERE r.consumed_task_id = t.id AND r.status = 'bound') THEN 'superseded'
    WHEN NOT public.mos_item_executable(t.id, NULL) THEN 'blocked_or_awaiting'
    WHEN NOT public.mos_is_working_day(public.mos_perf_today()) THEN 'day_off'
    ELSE NULL END;
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'MOS:OFFER_WITHDRAWN' USING ERRCODE = 'WS409',
      DETAIL = jsonb_build_object('reason', v_reason, 'task', p_task_id)::text;
  END IF;
  IF t.assignee_user_id = v_actor THEN
    RETURN jsonb_build_object('task_id', p_task_id, 'result', 'already_assigned');
  END IF;
  PERFORM public.mos_task_assign_apply(p_task_id, v_actor, false);
  RETURN jsonb_build_object('task_id', p_task_id, 'result', 'started_early',
                            'due_at', (SELECT due_at FROM public.workflow_role_tasks WHERE id = p_task_id));
END $$;

-- ── §4a Band C read (definer: reservations carry RLS with no browser policies) ─
CREATE OR REPLACE FUNCTION public.mos_planned_steps(p_user_id uuid, p_horizon_days integer DEFAULT NULL)
 RETURNS TABLE(band text, kind text, task_id uuid, reservation_id uuid, subject_table text, subject_id uuid,
               step_key text, role_key text, planned_day date, plan_due_at timestamptz,
               readiness text, executable boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_h int := COALESCE(p_horizon_days, public.mos_planning_num('band_c_horizon_days', 14)::int);
BEGIN
  IF auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM public.wassell_app_user_id(auth.uid())
     AND NOT public.wassell_mos_can('assign') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  -- B: offered to me
  SELECT 'available_early', 'task', t.id, t.reservation_id, t.subject_table, t.subject_id, t.step_key, t.role_key,
         t.scheduled_start, t.plan_due_at, public.mos_item_readiness(t.id, NULL), public.mos_item_executable(t.id, NULL)
    FROM public.workflow_role_tasks t
   WHERE t.status = 'open' AND t.assignee_user_id IS NULL AND t.offered_to_user_id = p_user_id
  UNION ALL
  -- C: open unassigned tasks of my roles that are not offered (planned to me, or to nobody)
  SELECT 'planned', 'task', t.id, t.reservation_id, t.subject_table, t.subject_id, t.step_key, t.role_key,
         t.scheduled_start, t.plan_due_at, public.mos_item_readiness(t.id, NULL), public.mos_item_executable(t.id, NULL)
    FROM public.workflow_role_tasks t
    LEFT JOIN public.mos_task_reservations r ON r.consumed_task_id = t.id AND r.status = 'bound'
   WHERE t.status = 'open' AND t.assignee_user_id IS NULL AND t.offered_to_user_id IS NULL
     AND public.mos_user_holds_role(p_user_id, t.role_key)
     AND (r.assignee_user_id IS NULL OR r.assignee_user_id = p_user_id)
     AND (t.scheduled_start IS NULL OR t.scheduled_start <= public.mos_perf_today() + v_h)
  UNION ALL
  -- C: my reservations with no task yet
  SELECT 'planned', 'reservation', NULL, r.id,
         CASE WHEN r.row_id IS NOT NULL THEN 'mos_content_rows' ELSE 'mos_content' END,
         COALESCE(r.row_id, r.content_id), r.step_key, r.role_key, r.planned_start,
         (SELECT c.plan_due_at FROM public.mos_plan_chain(
             CASE WHEN r.row_id IS NOT NULL THEN 'mos_content_rows' ELSE 'mos_content' END,
             COALESCE(r.row_id, r.content_id)) c WHERE c.step_key = r.step_key LIMIT 1),
         public.mos_item_readiness(NULL, r.id), public.mos_item_executable(NULL, r.id)
    FROM public.mos_task_reservations r
   WHERE r.status IN ('reserved','stale') AND r.assignee_user_id = p_user_id
     AND COALESCE(r.row_id, r.content_id) IS NOT NULL
     AND r.planned_start <= public.mos_perf_today() + v_h
     AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks x
                      WHERE x.subject_table = CASE WHEN r.row_id IS NOT NULL THEN 'mos_content_rows' ELSE 'mos_content' END
                        AND x.subject_id = COALESCE(r.row_id, r.content_id) AND x.status = 'open'
                        AND x.step_key = r.step_key)
  ORDER BY 9 NULLS LAST, 7;
END $$;

-- ── §1c publication risk — three branches, judged by time ───────────────────
CREATE OR REPLACE FUNCTION public.mos_publication_risk(p_subject_table text, p_subject_id uuid)
 RETURNS TABLE(projected_ready_at timestamptz, required_ready_at timestamptz, publish_at timestamptz,
               risk text, risk_step text, risk_reason text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_now      timestamptz := clock_timestamp();
  v_paid     boolean := false;
  v_open     public.workflow_role_tasks%ROWTYPE;
  v_ver      uuid; v_steps jsonb; v_pos int;
  v_cursor   timestamptz; v_target numeric; v_daystart timestamptz;
  v_lead     numeric; v_A date;
  v_n_tasks  int; v_complete boolean := false; v_has_live_res boolean;
  v_last_prod int;
  r          record;
  v_pub      record; v_ad record;
BEGIN
  projected_ready_at := NULL; required_ready_at := NULL; publish_at := NULL;
  risk := NULL; risk_step := NULL; risk_reason := NULL;

  IF p_subject_table = 'mos_content' THEN
    SELECT (c.purpose = 'paid') INTO v_paid FROM public.mos_content c WHERE c.id = p_subject_id;
  END IF;

  -- instants
  IF v_paid THEN
    SELECT s.activate_on INTO v_A FROM public.mos_creative_slots s
     WHERE s.content_id = p_subject_id AND s.activate_on IS NOT NULL ORDER BY s.activate_on LIMIT 1;
    v_lead := public.mos_planning_num('ad_build_lead_hours', 2);
    IF v_A IS NOT NULL THEN
      required_ready_at := public.mos_day_start(v_A) - make_interval(hours => v_lead::int);
      publish_at        := public.mos_day_start(v_A + 1);
    END IF;
  ELSE
    SELECT min(pb.planned_at) INTO publish_at
      FROM public.mos_publications pb JOIN public.mos_content c ON c.id = pb.content_id
     WHERE pb.status <> 'cancelled'
       AND ((p_subject_table = 'mos_content_rows' AND c.row_id = p_subject_id)
         OR (p_subject_table = 'mos_content' AND c.id = p_subject_id));
    v_lead := public.mos_planning_num('release_lead_hours', 2);
    IF publish_at IS NOT NULL THEN
      required_ready_at := publish_at - make_interval(hours => v_lead::int);
    END IF;
  END IF;

  v_ver := public.mos_subject_version_id(p_subject_table, p_subject_id);
  SELECT v.definition -> 'metadata' -> 'steps' INTO v_steps FROM public.workflow_versions v WHERE v.id = v_ver;

  SELECT count(*) INTO v_n_tasks FROM public.workflow_role_tasks
   WHERE subject_table = p_subject_table AND subject_id = p_subject_id;
  SELECT * INTO v_open FROM public.workflow_role_tasks
   WHERE subject_table = p_subject_table AND subject_id = p_subject_id AND status = 'open' LIMIT 1;

  -- (C) production complete? latest task done+approved/submitted at/after the last production step
  SELECT max(public.mos_step_sort(sr.step_key)) INTO v_last_prod
    FROM public.mos_step_rules sr WHERE sr.target_hours IS NOT NULL;
  IF v_open.id IS NULL AND v_n_tasks > 0 THEN
    SELECT (x.status = 'done' AND x.result IN ('approved','submitted')
            AND public.mos_step_sort(x.step_key) >= COALESCE(v_last_prod, 0)) INTO v_complete
      FROM public.workflow_role_tasks x
     WHERE x.subject_table = p_subject_table AND x.subject_id = p_subject_id
     ORDER BY x.round DESC, public.mos_step_sort(x.step_key) DESC, x.closed_at DESC NULLS LAST LIMIT 1;
  END IF;

  IF v_open.id IS NOT NULL THEN
    -- (B) in production
    IF v_open.blocked THEN
      risk := 'blocked'; risk_step := v_open.step_key; risk_reason := COALESCE(v_open.blocked_reason, 'blocked');
      RETURN NEXT; RETURN;
    END IF;
    risk_step := v_open.step_key;
    SELECT c.booked_day INTO v_daystart FROM public.mos_plan_chain(p_subject_table, p_subject_id) c
     WHERE c.step_key = v_open.step_key LIMIT 1;
    v_target := public.mos_step_target_hours(v_open.step_key);
    v_cursor := COALESCE(v_open.assigned_at,
                         GREATEST(v_now, COALESCE(public.mos_day_start(v_daystart::date), v_now)));
    v_cursor := GREATEST(v_now, CASE WHEN v_target IS NULL THEN v_cursor
                                     ELSE public.mos_work_due_at(v_cursor, v_target) END);
    SELECT ord - 1 INTO v_pos FROM jsonb_array_elements(v_steps) WITH ORDINALITY e(elem, ord)
     WHERE elem ->> 'key' = v_open.step_key LIMIT 1;
    FOR r IN
      SELECT elem ->> 'key' AS k FROM jsonb_array_elements(v_steps) WITH ORDINALITY e(elem, ord)
       WHERE ord - 1 > COALESCE(v_pos, -1) ORDER BY ord
    LOOP
      v_target := public.mos_step_target_hours(r.k);
      CONTINUE WHEN v_target IS NULL;
      SELECT c.booked_day INTO v_daystart FROM public.mos_plan_chain(p_subject_table, p_subject_id) c
       WHERE c.step_key = r.k LIMIT 1;
      v_cursor := public.mos_work_due_at(GREATEST(v_cursor, COALESCE(public.mos_day_start(v_daystart::date), v_cursor)), v_target);
    END LOOP;
    projected_ready_at := v_cursor;
  ELSIF v_n_tasks = 0 THEN
    -- (A) not started: the whole chain from the first booked day
    SELECT EXISTS (SELECT 1 FROM public.mos_plan_chain(p_subject_table, p_subject_id)) INTO v_has_live_res;
    IF NOT v_has_live_res THEN
      risk := 'unscheduled'; risk_reason := 'not planned'; RETURN NEXT; RETURN;
    END IF;
    v_cursor := NULL;
    FOR r IN SELECT * FROM public.mos_plan_chain(p_subject_table, p_subject_id) ORDER BY sort_order LOOP
      CONTINUE WHEN r.target_hours IS NULL;
      IF v_cursor IS NULL THEN
        v_cursor := public.mos_work_due_at(GREATEST(v_now, public.mos_day_start(r.booked_day)), r.target_hours);
        risk_step := r.step_key;
      ELSE
        v_cursor := public.mos_work_due_at(GREATEST(v_cursor, public.mos_day_start(r.booked_day)), r.target_hours);
      END IF;
    END LOOP;
    projected_ready_at := v_cursor;
  ELSIF NOT v_complete THEN
    -- stalled: tasks exist, none open, production not finished (D19)
    risk := 'at_risk'; risk_reason := 'stalled: no open task'; RETURN NEXT; RETURN;
  END IF;

  IF NOT v_complete THEN
    IF publish_at IS NULL THEN
      risk := 'unscheduled'; risk_reason := CASE WHEN v_paid THEN 'no activation day' ELSE 'no publish date' END;
    ELSIF projected_ready_at <= required_ready_at THEN risk := 'on_track';
    ELSIF projected_ready_at <= publish_at THEN risk := 'at_risk';
    ELSE risk := 'late'; END IF;
    RETURN NEXT; RETURN;
  END IF;

  -- (C) terminal: production complete — judged by what actually happened, by time
  risk_step := CASE WHEN v_paid THEN 'activation' ELSE 'publication' END;
  IF v_paid THEN
    SELECT ea.status, ea.activated_at, ea.platform_ad_id, ea.creative -> 'auto_ad' AS auto_ad INTO v_ad
      FROM public.mos_execution_ads ea
     WHERE ea.content_id = p_subject_id AND ea.archived_at IS NULL
     ORDER BY ea.created_at DESC LIMIT 1;
    IF v_A IS NULL THEN risk := 'unscheduled'; risk_reason := 'no activation day';
    ELSIF v_ad.activated_at IS NOT NULL OR v_ad.auto_ad ->> 'ad_status' = 'ACTIVE' THEN risk := 'active';
    ELSIF v_ad.platform_ad_id IS NOT NULL AND v_now < publish_at THEN risk := 'on_track';
    ELSIF v_now < required_ready_at THEN risk := 'on_track';
    ELSIF v_now < publish_at THEN risk := 'at_risk'; risk_reason := 'ad not built';
    ELSE risk := 'late'; risk_reason := 'activation day passed, ad not live'; END IF;
  ELSE
    SELECT bool_and(pb.published_at IS NOT NULL OR pb.status = 'published') AS all_pub,
           bool_or(pb.bundle_error IS NOT NULL) AS any_err,
           bool_or(pb.status = 'planned') AS any_planned,
           count(*) AS n INTO v_pub
      FROM public.mos_publications pb JOIN public.mos_content c ON c.id = pb.content_id
     WHERE pb.status <> 'cancelled'
       AND ((p_subject_table = 'mos_content_rows' AND c.row_id = p_subject_id)
         OR (p_subject_table = 'mos_content' AND c.id = p_subject_id));
    IF COALESCE(v_pub.n, 0) = 0 OR publish_at IS NULL THEN risk := 'unscheduled'; risk_reason := 'no publish date';
    ELSIF v_pub.all_pub THEN risk := 'published';
    ELSIF v_pub.any_err THEN risk := 'late'; risk_reason := 'publish failed';
    ELSIF publish_at >= v_now THEN
      IF v_now > required_ready_at AND v_pub.any_planned THEN risk := 'at_risk'; risk_reason := 'not handed off';
      ELSE risk := 'on_track'; END IF;
    ELSE risk := 'late'; risk_reason := 'publish time passed'; END IF;
  END IF;
  RETURN NEXT;
END $$;

/** The 10-minute risk cache: in-flight (open task) subjects get their verdict stamped on the task. */
CREATE OR REPLACE FUNCTION public.mos_risk_sweep()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE r record; v_n int := 0; v_late int := 0; v_at_risk int := 0;
BEGIN
  FOR r IN
    SELECT t.id, t.subject_table, t.subject_id FROM public.workflow_role_tasks t
     WHERE t.status = 'open' AND t.subject_table IN ('mos_content','mos_content_rows')
  LOOP
    UPDATE public.workflow_role_tasks t
       SET risk = pr.risk, risk_reason = pr.risk_reason, risk_at = now()
      FROM public.mos_publication_risk(r.subject_table, r.subject_id) pr
     WHERE t.id = r.id;
    v_n := v_n + 1;
  END LOOP;
  SELECT count(*) FILTER (WHERE risk = 'late'), count(*) FILTER (WHERE risk = 'at_risk')
    INTO v_late, v_at_risk FROM public.workflow_role_tasks WHERE status = 'open';
  RETURN jsonb_build_object('evaluated', v_n, 'late', v_late, 'at_risk', v_at_risk);
END $$;

-- ── rewired entry points (names + signatures unchanged) ─────────────────────

CREATE OR REPLACE FUNCTION public.workflow_role_path_start(p_subject_table text, p_subject_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_out jsonb; v_role text;
BEGIN
  PERFORM public.mos_ledger_lock();
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('write_content') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_out := public.mos_task_open(p_subject_table, p_subject_id);
  IF (v_out ->> 'opened_task_id') IS NOT NULL THEN
    SELECT role_key INTO v_role FROM public.workflow_role_tasks WHERE id = (v_out ->> 'opened_task_id')::uuid;
    PERFORM public.mos_refill_request(ARRAY[v_role]);
  END IF;
  RETURN v_out;
END $$;

-- Legacy names: dispatch is a refill request now; nothing assigns outside refill.
CREATE OR REPLACE FUNCTION public.mos_task_dispatch(p_task_id uuid, p_notify boolean DEFAULT false)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text;
BEGIN
  SELECT role_key INTO v_role FROM public.workflow_role_tasks WHERE id = p_task_id;
  IF v_role IS NULL THEN RETURN 'not_open'; END IF;
  PERFORM public.mos_refill_request(ARRAY[v_role]);
  RETURN CASE WHEN EXISTS (SELECT 1 FROM public.workflow_role_tasks WHERE id = p_task_id AND assignee_user_id IS NOT NULL)
              THEN 'assigned' ELSE 'waiting' END;
END $$;

CREATE OR REPLACE FUNCTION public.mos_perf_place_open_task(p_task_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_role text;
BEGIN
  SELECT role_key INTO v_role FROM public.workflow_role_tasks WHERE id = p_task_id;
  IF v_role IS NOT NULL THEN PERFORM public.mos_refill_request(ARRAY[v_role]); END IF;
END $$;

CREATE OR REPLACE FUNCTION public.mos_dispatch_sweep()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  RETURN public.mos_refill(NULL);
END $$;

-- Opens what is due (rows, planned content, refresh-cycle shells) then refills.
-- The old `mos_role_has_room` gate is gone (D2): planned work is opened on its
-- day, full stop; the plan and the commit guard are the cap.
CREATE OR REPLACE FUNCTION public.mos_plan_start_due()
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_today   date := public.mos_perf_today();
  r record; s record;
  v_started int := 0; v_rows int := 0; v_shells int := 0; v_cycles int := 0;
  v_ct uuid; v_ver uuid; v_new uuid; v_first jsonb; v_res jsonb;
BEGIN
  PERFORM public.mos_ledger_lock();
  PERFORM set_config('mos.in_refill', '1', true);   -- openers below only queue refills

  FOR r IN
    SELECT q.st, q.id, q.ver
      FROM (
        SELECT 'mos_content_rows'::text AS st, rw.id, rw.workflow_version_id AS ver
          FROM public.mos_content_rows rw
         WHERE EXISTS (SELECT 1 FROM public.mos_task_reservations tr
                        WHERE tr.row_id = rw.id AND tr.status IN ('reserved','stale')
                          AND tr.planned_start <= v_today)
           AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                            WHERE t.subject_table = 'mos_content_rows' AND t.subject_id = rw.id)
        UNION ALL
        SELECT 'mos_content', c.id, c.workflow_version_id
          FROM public.mos_content_plan cp
          JOIN public.mos_content c ON c.id = cp.content_id AND c.row_id IS NULL
         WHERE cp.status = 'planned'
           AND (cp.production_start IS NOT NULL AND cp.production_start <= v_today
                OR EXISTS (SELECT 1 FROM public.mos_task_reservations tr
                            WHERE tr.content_id = c.id AND tr.status IN ('reserved','stale')
                              AND tr.planned_start <= v_today))
           AND NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                            WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id)
      ) q
     WHERE NOT public.mos_subject_inactive(q.st, q.id)
     ORDER BY public.mos_subject_publish_at(q.st, q.id) ASC NULLS LAST, public.mos_subject_publish_rank(q.st, q.id) ASC, q.id
  LOOP
    SELECT v.definition->'metadata'->'steps'->0 INTO v_first FROM public.workflow_versions v WHERE v.id = r.ver;
    IF v_first IS NULL THEN
      RAISE WARNING 'MOS:START_NO_WORKFLOW % % has no pinned workflow steps', r.st, r.id;
      CONTINUE;
    END IF;
    v_res := public.mos_task_open(r.st, r.id);
    IF (v_res ->> 'opened_task_id') IS NULL THEN CONTINUE; END IF;
    IF r.st = 'mos_content_rows' THEN
      UPDATE public.mos_content_plan cp SET status = 'in_production'
       WHERE cp.status = 'planned'
         AND cp.content_id IN (SELECT c.id FROM public.mos_content c WHERE c.row_id = r.id);
      v_rows := v_rows + 1;
    ELSE
      UPDATE public.mos_content_plan SET status = 'in_production' WHERE content_id = r.id;
    END IF;
    v_started := v_started + 1;
  END LOOP;

  UPDATE public.mos_content_plan cp SET status = 'in_production'
   WHERE cp.status = 'planned'
     AND (EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                   WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id)
       OR EXISTS (SELECT 1 FROM public.mos_content c
                    JOIN public.workflow_role_tasks t ON t.subject_table = 'mos_content_rows' AND t.subject_id = c.row_id
                   WHERE c.id = cp.content_id));

  FOR r IN
    SELECT cy.id AS cycle_id, cy.execution_id, cy.round, ex.campaign_id, cm.name AS campaign_name, cm.project_id
      FROM public.mos_refresh_cycles cy
      JOIN public.mos_campaign_executions ex ON ex.id = cy.execution_id
      LEFT JOIN public.mos_campaigns cm ON cm.id = ex.campaign_id
     WHERE cy.status = 'scheduled' AND cy.production_start_on IS NOT NULL AND cy.production_start_on <= v_today
     ORDER BY cy.production_start_on, cy.round
  LOOP
    SELECT ct.id, (SELECT wv.id FROM public.workflow_versions wv WHERE wv.workflow_id = ct.workflow_id ORDER BY wv.version_no DESC LIMIT 1)
      INTO v_ct, v_ver FROM public.mos_content_types ct WHERE ct.key = 'post' AND ct.archived_at IS NULL;
    IF v_ct IS NOT NULL THEN
      FOR s IN
        SELECT sl.id, sl.slot_index, sl.kind, sl.content_key FROM public.mos_creative_slots sl
         WHERE sl.cycle_id = r.cycle_id AND sl.content_id IS NULL AND sl.status = 'reserved'
         ORDER BY sl.slot_index
      LOOP
        INSERT INTO public.mos_content (content_type_id, workflow_id, workflow_version_id, title, project_id, project_ids, campaign_id, purpose)
        SELECT v_ct, ct.workflow_id, v_ver,
               COALESCE(r.campaign_name, 'حملة') || ' — تحديث ' || r.round || '/' || (s.slot_index + 1),
               r.project_id,
               CASE WHEN r.project_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(r.project_id) END,
               r.campaign_id, 'paid'
          FROM public.mos_content_types ct WHERE ct.id = v_ct
        RETURNING id INTO v_new;
        UPDATE public.mos_creative_slots SET content_id = v_new, status = 'producing' WHERE id = s.id;
        UPDATE public.mos_task_reservations SET content_id = v_new
         WHERE content_id IS NULL AND row_id IS NULL AND cycle_id = r.cycle_id
           AND content_key IS NOT NULL AND content_key = s.content_key;
        PERFORM public.mos_task_open('mos_content', v_new);
        v_started := v_started + 1; v_shells := v_shells + 1;
      END LOOP;
    END IF;
    UPDATE public.mos_refresh_cycles SET status = 'producing' WHERE id = r.cycle_id AND status = 'scheduled';
    v_cycles := v_cycles + 1;
  END LOOP;

  PERFORM set_config('mos.in_refill', '0', true);
  RETURN jsonb_build_object('started', v_started, 'rows_started', v_rows, 'shells_created', v_shells,
                            'cycles_started', v_cycles, 'dispatch', public.mos_refill(NULL));
END $$;

-- Repair no longer re-dates anything and never writes risk: a past-day booking
-- with no task is marked `stale` (the ledger charges it from today) and left
-- for the re-plan; bound/consumed rows are never touched.
CREATE OR REPLACE FUNCTION public.mos_plan_repair(p_campaign_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_today date := public.mos_perf_today(); v_staled int := 0; v_late int := 0; v_batches int := 0;
BEGIN
  PERFORM public.mos_ledger_lock();
  UPDATE public.mos_task_reservations res
     SET status = 'stale', updated_at = now()
   WHERE res.status = 'reserved' AND res.planned_end < v_today AND res.consumed_task_id IS NULL
     AND (p_campaign_id IS NULL
          OR EXISTS (SELECT 1 FROM public.mos_content_plan cp
                      WHERE cp.content_id = res.content_id AND cp.campaign_id = p_campaign_id));
  GET DIAGNOSTICS v_staled = ROW_COUNT;

  UPDATE public.mos_content_plan cp SET status = 'late'
   WHERE cp.status IN ('planned','in_production','at_risk')
     AND cp.required_ready_at IS NOT NULL AND cp.required_ready_at < v_today
     AND (p_campaign_id IS NULL OR cp.campaign_id = p_campaign_id);
  GET DIAGNOSTICS v_late = ROW_COUNT;

  UPDATE public.mos_publish_batches b SET status = v.risk
    FROM public.mos_publish_batch_v v
   WHERE v.id = b.id AND b.status <> v.risk
     AND v.risk IN ('planned','on_track','at_risk','late','done')
     AND (p_campaign_id IS NULL OR b.campaign_id = p_campaign_id);
  GET DIAGNOSTICS v_batches = ROW_COUNT;

  RETURN jsonb_build_object('staled', v_staled, 'redated', 0, 'at_risk', 0, 'late', v_late,
                            'batches', v_batches, 'risk', public.mos_risk_sweep());
END $$;

-- ── D9: archiving content closes its open tasks ─────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_tg_content_archive_close_tasks()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    UPDATE public.workflow_role_tasks
       SET status = 'skipped', late_flag = false, closed_at = now(), updated_at = now(),
           note = COALESCE(note, '') || ' archived'
     WHERE subject_table = 'mos_content' AND subject_id = NEW.id AND status = 'open';
    UPDATE public.mos_manual_tasks
       SET status = 'cancelled', late_flag = false, closed_at = now(), updated_at = now()
     WHERE content_id = NEW.id AND status = 'open';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS mos_content_archive_close_tasks_tg ON public.mos_content;
CREATE TRIGGER mos_content_archive_close_tasks_tg
  AFTER UPDATE OF archived_at ON public.mos_content
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_content_archive_close_tasks();

-- ── the audit: rules restated for the new engine ────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_task_rules_audit()
 RETURNS TABLE(rule text, ref_id uuid, detail text)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  RETURN QUERY
  WITH b AS (
    SELECT r.id, r.step_key, r.planned_start,
           COALESCE(r.row_id::text, r.content_id::text, r.content_key) AS subj,
           public.mos_step_sort(r.step_key) AS so
      FROM public.mos_task_reservations r
     WHERE r.status IN ('reserved','stale','bound')
  )
  SELECT 'R1_order', later.id,
         format('%s booked %s, before %s booked %s', later.step_key, later.planned_start, earlier.step_key, earlier.planned_start)
    FROM b later JOIN b earlier ON earlier.subj = later.subj AND earlier.so < later.so
   WHERE later.planned_start < earlier.planned_start;

  RETURN QUERY
  SELECT 'R2_uncounted', r.id,
         format('consumed reservation behind OPEN UNASSIGNED task %s (counted by nobody)', t.id)
    FROM public.mos_task_reservations r JOIN public.workflow_role_tasks t ON t.id = r.consumed_task_id
   WHERE r.status = 'consumed' AND t.status = 'open' AND t.assignee_user_id IS NULL;

  RETURN QUERY
  SELECT 'R3_deadline', t.id,
         format('%s due %s below its planned deadline %s', t.step_key,
                t.due_at AT TIME ZONE 'Asia/Riyadh', t.plan_due_at AT TIME ZONE 'Asia/Riyadh')
    FROM public.workflow_role_tasks t
   WHERE t.status = 'open' AND t.assignee_user_id IS NOT NULL
     AND t.handoff_slip IS NOT NULL   -- assigned by the new engine; legacy deadlines are left as they are (decision A)
     AND t.plan_due_at IS NOT NULL AND t.due_at IS NOT NULL AND t.due_at < t.plan_due_at - interval '1 minute';

  RETURN QUERY
  SELECT 'R4_role', t.id,
         format('%s is with %s, who does not hold %s', t.step_key,
                (SELECT u.email FROM public.users u WHERE u.id = t.assignee_user_id), t.role_key)
    FROM public.workflow_role_tasks t
   WHERE t.status = 'open' AND t.assignee_user_id IS NOT NULL
     AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id)
     AND NOT public.mos_user_holds_role(t.assignee_user_id, t.role_key);

  RETURN QUERY
  SELECT 'R5_due_unassigned', t.id,
         format('%s planned %s is unassigned on a working day with a holder available', t.step_key, t.scheduled_start)
    FROM public.workflow_role_tasks t
   WHERE t.status = 'open' AND t.assignee_user_id IS NULL AND t.reservation_id IS NOT NULL
     AND t.scheduled_start <= public.mos_perf_today()
     AND public.mos_is_working_day(public.mos_perf_today())
     AND public.mos_item_readiness(t.id, NULL) = 'ready'
     AND EXISTS (SELECT 1 FROM public.mos_role_routine_holders(t.role_key));

  RETURN QUERY
  SELECT 'R6_offer_ineligible', t.id,
         format('%s offered to %s but no longer eligible', t.step_key,
                (SELECT u.email FROM public.users u WHERE u.id = t.offered_to_user_id))
    FROM public.workflow_role_tasks t
   WHERE t.status = 'open' AND t.assignee_user_id IS NULL AND t.offered_to_user_id IS NOT NULL
     AND NOT public.mos_offer_eligible(t.id, t.offered_to_user_id);

  RETURN QUERY
  SELECT 'R7_opted_out', t.id,
         format('%s handed to %s, who takes no routine %s work', t.step_key,
                (SELECT u.email FROM public.users u WHERE u.id = t.assignee_user_id), t.role_key)
    FROM public.workflow_role_tasks t
    JOIN public.mos_auto_assign_opt_out o ON o.user_id = t.assignee_user_id AND o.role_key = t.role_key
   WHERE t.status = 'open' AND t.assigned_at IS NOT NULL AND t.assigned_at > o.created_at;

  RETURN QUERY
  SELECT 'R8_readiness_vocabulary', t.id, format('unknown readiness token %s', public.mos_item_readiness(t.id, NULL))
    FROM public.workflow_role_tasks t
   WHERE t.status = 'open' AND NOT public.mos_readiness_is_known(public.mos_item_readiness(t.id, NULL));
END $$;

COMMIT;
