-- ============================================================================
-- Plan-driven task assignment — 8/8: a RE-PLAN of a running month keeps
-- started work (2026-09-22, D11 / D16).
--
-- Found while previewing the September re-plan with the new planner: the
-- launch batch (due today, its designs already in people's hands) was fed back
-- to the planner, could not be produced before today, made every paid plan
-- `time_bound`, and the confirm refused the month with "81 items have no
-- production plan". Two halves fix it — the planner half is in
-- api/_lib/marketing/planning/{monthCompiler,monthActions}.ts (a batch
-- already in production is FROZEN: kept in the round numbering, nothing new
-- produced); this is the database half:
--
--   1. mos_plan_resolve_carry — a subject the new plan names is carried whether
--      its existing booking is bound, consumed, reserved or stale; the commit
--      keeps a consumed step's dates and re-dates the rest (a stale one is live
--      again).
--   2. mos_retire_superseded — a STARTED subject (a task done, or open in
--      someone's hands) never loses a booking: what the new plan does not name
--      is adopted by it, dates untouched. Unstarted, un-named work is retired
--      as before.
--   3. mos_capacity_check — the guard now counts every entry at its NEW dates
--      (re-dated carried entries included) and ignores those entries' OLD
--      ledger rows, instead of subtracting carried entries and counting their
--      old cells; the kept (consumed) entries are excluded because their task
--      already sits in the ledger.
--
-- All four functions are re-emitted from their LIVE definitions with only
-- these changes. Idempotent. No SQLSTATE 40001/40P01 is raised anywhere.
-- ============================================================================

BEGIN;

/** Has anyone begun this subject? A task closed, or open in someone's hands. */
CREATE OR REPLACE FUNCTION public.mos_subject_started(p_subject_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p_subject_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.workflow_role_tasks t
     WHERE t.subject_id = p_subject_id
       AND (t.status = 'done' OR (t.status = 'open' AND t.assignee_user_id IS NOT NULL)));
$$;

CREATE OR REPLACE FUNCTION public.mos_plan_resolve_carry(p_campaign_id uuid, p_plan_id uuid, p_reservations jsonb, p_materialise jsonb)
 RETURNS TABLE(idx integer, item_key text, row_key text, step_key text, subject_key text, reservation_id uuid, res_status text, res_plan_id uuid, res_task_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH execs AS (
    SELECT e ->> 'key' AS ekey,
           COALESCE(NULLIF(e ->> 'execution_id', '')::uuid,
                    (SELECT x.id FROM public.mos_campaign_executions x
                      WHERE p_campaign_id IS NOT NULL AND x.campaign_id = p_campaign_id
                        AND x.platform = e ->> 'platform' AND COALESCE(x.label, '') = '' AND x.archived_at IS NULL
                      LIMIT 1)) AS eid
      FROM jsonb_array_elements(COALESCE(p_materialise -> 'executions', '[]'::jsonb)) e),
  entries AS (
    SELECT (ord - 1)::int AS idx, r ->> 'item_key' AS item_key, NULLIF(r ->> 'row_key', '') AS row_key,
           r ->> 'step_key' AS step_key, NULLIF(r ->> 'cycle_key', '') AS cycle_key, NULLIF(r ->> 'cycle_id', '') AS cycle_id_txt
      FROM jsonb_array_elements(COALESCE(p_reservations, '[]'::jsonb)) WITH ORDINALITY t(r, ord)),
  resolved AS (
    SELECT en.idx, en.item_key, en.row_key, en.step_key,
      CASE WHEN en.row_key IS NOT NULL THEN
             (SELECT rw.id::text FROM public.mos_content_rows rw WHERE rw.row_key = en.row_key)
           ELSE COALESCE(
             (SELECT cp.content_id::text FROM public.mos_content_plan cp
                LEFT JOIN public.mos_campaign_plans p ON p.id = cp.plan_id
               WHERE cp.content_key = en.item_key
                 AND (cp.plan_id = p_plan_id OR (p_campaign_id IS NOT NULL AND p.campaign_id = p_campaign_id))
               LIMIT 1),
             (SELECT sl.content_id::text FROM public.mos_creative_slots sl
               WHERE sl.content_key = en.item_key AND sl.content_id IS NOT NULL
                 AND sl.execution_id IN (SELECT eid FROM execs WHERE eid IS NOT NULL) LIMIT 1),
             (SELECT cy.id::text || ':' || en.item_key FROM public.mos_refresh_cycles cy
               WHERE cy.id = COALESCE(en.cycle_id_txt::uuid,
                       (SELECT cy2.id FROM public.mos_refresh_cycles cy2 JOIN execs ex ON ex.eid = cy2.execution_id
                         WHERE en.cycle_key IS NOT NULL AND ex.ekey = split_part(en.cycle_key, '#', 1)
                           AND cy2.round = NULLIF(split_part(en.cycle_key, '#', 2), '')::int LIMIT 1)))
           ) END AS subject_key
      FROM entries en)
  SELECT r.idx, r.item_key, r.row_key, r.step_key, r.subject_key, res.id, res.status, res.plan_id, res.consumed_task_id
    FROM resolved r
    JOIN public.mos_task_reservations res
      ON res.step_key = r.step_key AND res.status IN ('bound','consumed','reserved','stale')
     AND COALESCE(res.content_id::text, res.row_id::text, res.cycle_id::text || ':' || res.content_key) = r.subject_key
   WHERE r.subject_key IS NOT NULL;
$function$;

CREATE OR REPLACE FUNCTION public.mos_retire_superseded(p_campaign_id uuid, p_keep_plan_id uuid, p_by_plan uuid, p_carry_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_repl uuid[]; v_retired int := 0; v_closed int := 0; v_plans int := 0; v_adopted int := 0; v_carry uuid[] := COALESCE(p_carry_ids, '{}');
BEGIN
  IF p_campaign_id IS NULL THEN
    RETURN jsonb_build_object('retired', 0, 'tasks_closed', 0, 'plans', 0);
  END IF;
  SELECT array_agg(id) INTO v_repl FROM public.mos_campaign_plans
   WHERE campaign_id = p_campaign_id AND status IN ('proposed','approved') AND id <> p_keep_plan_id;
  IF v_repl IS NULL THEN
    RETURN jsonb_build_object('retired', 0, 'tasks_closed', 0, 'plans', 0);
  END IF;

  -- 1a unconsumed bookings → history — EXCEPT a STARTED subject's (D11, 2026-09-22):
  --    an item someone has begun keeps every booking it holds; the steps the new
  --    plan names are re-dated through the carry, the rest are adopted as they are.
  UPDATE public.mos_task_reservations r
     SET status = 'superseded', superseded_by_plan_id = p_by_plan, superseded_at = now(), updated_at = now()
   WHERE r.plan_id = ANY (v_repl) AND r.status IN ('reserved','stale') AND r.consumed_task_id IS NULL
     AND NOT (r.id = ANY (v_carry))
     AND NOT public.mos_subject_started(COALESCE(r.content_id, r.row_id));
  GET DIAGNOSTICS v_retired = ROW_COUNT;

  -- 1a' a started subject's bookings the new plan does not name follow it, dates untouched
  UPDATE public.mos_task_reservations r
     SET plan_id = p_keep_plan_id, updated_at = now()
   WHERE r.plan_id = ANY (v_repl) AND r.status IN ('reserved','stale','bound','consumed')
     AND NOT (r.id = ANY (v_carry))
     AND public.mos_subject_started(COALESCE(r.content_id, r.row_id));
  GET DIAGNOSTICS v_adopted = ROW_COUNT;

  -- 1b bound (opened, unassigned) bookings the new plan does NOT carry: the task
  --    closes as skipped, the booking becomes history. Offered work adds no
  --    mandatory workload — the offer is withdrawn, it never becomes a deadline.
  WITH gone AS (
    SELECT r.id AS res_id, r.consumed_task_id AS task_id
      FROM public.mos_task_reservations r
      JOIN public.workflow_role_tasks t ON t.id = r.consumed_task_id
     WHERE r.plan_id = ANY (v_repl) AND r.status = 'bound' AND NOT (r.id = ANY (v_carry))
       AND t.status = 'open' AND t.assignee_user_id IS NULL
       AND NOT public.mos_subject_started(COALESCE(r.content_id, r.row_id))),
  closed AS (
    UPDATE public.workflow_role_tasks t
       SET status = 'skipped', closed_at = now(), offered_to_user_id = NULL, offered_at = NULL,
           late_flag = false, updated_at = now(),
           note = COALESCE(t.note, '') || ' plan_superseded:' || COALESCE(p_by_plan::text, '-')
      FROM gone WHERE t.id = gone.task_id
    RETURNING t.id)
  UPDATE public.mos_task_reservations r
     SET status = 'superseded', superseded_by_plan_id = p_by_plan, superseded_at = now(), updated_at = now()
    FROM closed WHERE r.consumed_task_id = closed.id;
  GET DIAGNOSTICS v_closed = ROW_COUNT;

  -- 1c consumed (assigned) bookings: untouched; still counted through the task.
  -- 1d the plans
  UPDATE public.mos_campaign_plans
     SET status = 'superseded', superseded_by = p_by_plan, updated_at = now()
   WHERE id = ANY (v_repl);
  GET DIAGNOSTICS v_plans = ROW_COUNT;

  RETURN jsonb_build_object('retired', v_retired, 'tasks_closed', v_closed, 'plans', v_plans, 'adopted', v_adopted);
END $function$;

CREATE OR REPLACE FUNCTION public.mos_capacity_check(p_reservations jsonb, p_extra_cells jsonb DEFAULT '[]'::jsonb, p_ignore_reservation_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH prop AS (
    SELECT (x ->> 'assignee_user_id')::uuid AS uid, COALESCE(x ->> 'bucket', 'post') AS bucket,
           (x ->> 'planned_start')::date AS ps, COALESCE((x ->> 'weight')::numeric, 1) AS total,
           NULLIF(x ->> 'row_key', '') IS NOT NULL AS same_day
      FROM jsonb_array_elements(COALESCE(p_reservations, '[]'::jsonb)) x
     WHERE NULLIF(x ->> 'assignee_user_id', '') IS NOT NULL),
  spread AS (
    SELECT prop.uid, prop.bucket, s.day, s.weight AS w
      FROM prop CROSS JOIN LATERAL public.mos_spread_effort_mode(GREATEST(prop.ps, public.mos_perf_today()), prop.total, prop.same_day) s),
  extra AS (
    SELECT (x ->> 'user_id')::uuid AS uid, COALESCE(x ->> 'bucket', 'post') AS bucket, (x ->> 'day')::date AS day, 0::numeric AS w
      FROM jsonb_array_elements(COALESCE(p_extra_cells, '[]'::jsonb)) x
     WHERE NULLIF(x ->> 'user_id', '') IS NOT NULL AND NULLIF(x ->> 'day', '') IS NOT NULL),
  agg AS (
    SELECT uid, bucket, day, sum(w) AS proposed FROM (SELECT * FROM spread UNION ALL SELECT * FROM extra) u GROUP BY 1, 2, 3)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.uid, 'day', a.day, 'bucket', a.bucket,
           'existing', x.existing, 'proposed', a.proposed,
           'capacity', public.mos_user_daily_slots(a.uid, a.bucket),
           'on_leave', public.mos_on_leave(a.uid, a.day))), '[]'::jsonb)
    FROM agg a
    CROSS JOIN LATERAL (SELECT COALESCE(sum(l.weight), 0) AS existing FROM public.mos_work_ledger_v l
                         WHERE l.user_id = a.uid AND l.day = a.day AND l.bucket = a.bucket
                           AND NOT (l.source = 'reservation' AND l.ref_id = ANY (COALESCE(p_ignore_reservation_ids, '{}'::uuid[])))) x
   WHERE public.mos_on_leave(a.uid, a.day)
      OR (x.existing + a.proposed) > public.mos_user_daily_slots(a.uid, a.bucket);
$function$;

CREATE OR REPLACE FUNCTION public.mos_campaign_plan_commit(p_plan_id uuid, p_reservations jsonb, p_expected_hash text, p_materialise jsonb, p_actor uuid, p_batch_mode boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_plan     public.mos_campaign_plans%ROWTYPE;
  v_hash     text;
  v_cells    jsonb;
  v_campaign uuid;
  v_kind     text;
  v_rs       date;
  v_re       date;
  v_exec_map jsonb := '{}'::jsonb;
  v_item_map jsonb := '{}'::jsonb;
  v_batch_map jsonb := '{}'::jsonb;
  v_cycle_map jsonb := '{}'::jsonb;
  e          jsonb;
  it         jsonb;
  pl         jsonb;
  v_id       uuid;
  v_ct       uuid;
  v_ver      uuid;
  v_n_items  int := 0;
  v_n_res    int := 0;
  v_n_kept   int := 0;
  v_n_batch  int := 0;
  v_n_pub    int := 0;
  v_n_slot   int := 0;
  v_n_cycle  int := 0;
  v_row_map   jsonb := '{}'::jsonb;
  v_pair_map  jsonb := '{}'::jsonb;
  v_pl        jsonb;
  v_row_id    uuid;
  v_cycle_id  uuid;
  v_res_cid   uuid;
  v_pub_id    uuid;
  v_pair_uuid uuid;
  v_pair_key  text;
  v_variant   text;
  v_n_rows    int := 0;
  v_n_rel     int := 0;
  v_carry_idx int[] := '{}';
  v_carry_ids uuid[] := '{}';
  v_kept_idx  int[]  := '{}';
  v_moved_ids uuid[] := '{}';
  v_idx       int;
  c           record;
  v_retire    jsonb := '{}'::jsonb;
  v_subj_key  text;
  v_live      public.mos_task_reservations%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('approve_plan') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- (a) the lock, first
  PERFORM public.mos_ledger_lock();

  SELECT * INTO v_plan FROM public.mos_campaign_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:PLAN_NOT_FOUND %', p_plan_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_plan.status = 'approved' THEN
    RETURN jsonb_build_object(
      'already', true, 'plan_id', p_plan_id,
      'items',        (SELECT count(*) FROM public.mos_content_plan      WHERE plan_id = p_plan_id),
      'reservations', (SELECT count(*) FROM public.mos_task_reservations WHERE plan_id = p_plan_id),
      'batches',      (SELECT count(*) FROM public.mos_publish_batches   WHERE plan_id = p_plan_id),
      'publications', (SELECT count(*) FROM public.mos_publications p
                        JOIN public.mos_publish_batches b ON b.id = p.batch_id WHERE b.plan_id = p_plan_id),
      'slots',        (SELECT count(*) FROM public.mos_creative_slots    WHERE plan_id = p_plan_id),
      'cycles',       (SELECT count(*) FROM public.mos_refresh_cycles    WHERE plan_id = p_plan_id),
      'rows',         (SELECT count(*) FROM public.mos_content_rows      WHERE plan_id = p_plan_id));
  END IF;
  IF v_plan.status <> 'proposed' THEN
    RAISE EXCEPTION 'MOS:PLAN_NOT_PROPOSED %', v_plan.status USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- (b) the hash gate
  v_hash := public.mos_workload_snapshot_hash();
  IF p_expected_hash IS NOT NULL AND p_expected_hash <> v_hash THEN
    RAISE EXCEPTION 'plan_changed'
      USING ERRCODE = 'WS409',
            DETAIL  = jsonb_build_object('expected', p_expected_hash, 'actual', v_hash)::text,
            HINT    = 'the workload moved since the preview — re-plan';
  END IF;

  -- (c0) the campaign this plan belongs to (NULL = a fresh campaign, D10)
  v_campaign := COALESCE(NULLIF(p_materialise ->> 'campaign_id', '')::uuid, v_plan.campaign_id);
  v_kind     := COALESCE(p_materialise ->> 'kind', 'organic');
  v_rs       := NULLIF(p_materialise ->> 'range_start', '')::date;
  v_re       := NULLIF(p_materialise ->> 'range_end', '')::date;

  -- (c1) the carry set: payload entries whose subject already holds a LIVE booking
  SELECT COALESCE(array_agg(x.idx), '{}'), COALESCE(array_agg(x.reservation_id), '{}'),
         COALESCE(array_agg(x.idx) FILTER (WHERE x.res_status = 'consumed'), '{}'),
         COALESCE(array_agg(x.reservation_id) FILTER (WHERE x.res_status <> 'consumed'), '{}')
    INTO v_carry_idx, v_carry_ids, v_kept_idx, v_moved_ids
    FROM public.mos_plan_resolve_carry(v_campaign, p_plan_id, p_reservations, p_materialise) x;

  IF NOT p_batch_mode THEN
    -- Phase 1: retire the replaced plans (carried rows and started work untouched)
    v_retire := public.mos_retire_superseded(v_campaign, p_plan_id, p_plan_id, v_carry_ids);
    -- Phase 2: ONE guard — everything the plan books at its NEW dates (a re-dated
    -- carried entry included, its OLD ledger rows ignored) minus the entries
    -- that keep their dates (consumed: already counted through their task)
    v_cells := public.mos_capacity_check(
                 public.mos_plan_proposed_minus(p_reservations, v_kept_idx), '[]'::jsonb, v_moved_ids);
    IF jsonb_array_length(v_cells) > 0 THEN
      RAISE EXCEPTION 'capacity_conflict'
        USING ERRCODE = 'WS409', DETAIL = v_cells::text, HINT = 'the plan would overbook these cells';
    END IF;
  END IF;

  -- (d) materialise ------------------------------------------------------
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_materialise -> 'executions', '[]'::jsonb)) LOOP
    v_id := NULLIF(e ->> 'execution_id', '')::uuid;
    IF v_id IS NULL AND v_campaign IS NOT NULL THEN
      SELECT id INTO v_id FROM public.mos_campaign_executions
       WHERE campaign_id = v_campaign AND platform = e ->> 'platform' AND COALESCE(label, '') = '' AND archived_at IS NULL
       LIMIT 1;
    END IF;
    IF v_id IS NULL THEN
      INSERT INTO public.mos_campaign_executions
        (campaign_id, platform, status, starts_on, ends_on, source, refresh_policy, publishing_rules)
      VALUES (v_campaign, e ->> 'platform', 'draft', v_rs, v_re, 'manual',
              CASE WHEN e -> 'refresh_policy'   = 'null'::jsonb THEN NULL ELSE e -> 'refresh_policy'   END,
              CASE WHEN e -> 'publishing_rules' = 'null'::jsonb THEN NULL ELSE e -> 'publishing_rules' END)
      RETURNING id INTO v_id;
    ELSE
      UPDATE public.mos_campaign_executions
         SET starts_on        = COALESCE(starts_on, v_rs),
             ends_on          = COALESCE(ends_on, v_re),
             refresh_policy   = COALESCE(CASE WHEN e -> 'refresh_policy'   = 'null'::jsonb THEN NULL ELSE e -> 'refresh_policy'   END, refresh_policy),
             publishing_rules = COALESCE(CASE WHEN e -> 'publishing_rules' = 'null'::jsonb THEN NULL ELSE e -> 'publishing_rules' END, publishing_rules)
       WHERE id = v_id;
    END IF;
    v_exec_map := v_exec_map || jsonb_build_object(e ->> 'key', v_id::text);
  END LOOP;

  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_materialise -> 'rows', '[]'::jsonb)) LOOP
    CONTINUE WHEN NULLIF(e ->> 'row_key', '') IS NULL;
    v_ver := NULL;
    SELECT (SELECT wv.id FROM public.workflow_versions wv WHERE wv.workflow_id = ct.workflow_id ORDER BY wv.version_no DESC LIMIT 1)
      INTO v_ver
      FROM public.mos_content_types ct
     WHERE ct.archived_at IS NULL
       AND ct.key = (SELECT it2.value ->> 'content_type_key'
                       FROM jsonb_array_elements(COALESCE(p_materialise -> 'items', '[]'::jsonb)) it2
                      WHERE it2.value ->> 'row_key' = e ->> 'row_key'
                      ORDER BY COALESCE((it2.value ->> 'row_order')::int, 0) LIMIT 1);
    SELECT id INTO v_id FROM public.mos_content_rows WHERE row_key = e ->> 'row_key';
    IF v_id IS NULL THEN
      INSERT INTO public.mos_content_rows (campaign_id, project_id, plan_id, kind, batch_day, workflow_version_id, row_key)
      VALUES (v_campaign, NULLIF(e ->> 'project_id', '')::uuid, p_plan_id,
              COALESCE(NULLIF(e ->> 'kind', ''), 'organic_row'), NULLIF(e ->> 'batch_day', '')::date, v_ver, e ->> 'row_key')
      RETURNING id INTO v_id;
      v_n_rows := v_n_rows + 1;
    ELSE
      UPDATE public.mos_content_rows
         SET campaign_id = COALESCE(v_campaign, campaign_id), plan_id = p_plan_id,
             project_id = NULLIF(e ->> 'project_id', '')::uuid,
             kind = COALESCE(NULLIF(e ->> 'kind', ''), kind),
             batch_day = COALESCE(NULLIF(e ->> 'batch_day', '')::date, batch_day),
             workflow_version_id = COALESCE(v_ver, workflow_version_id), updated_at = now()
       WHERE id = v_id;
    END IF;
    v_row_map := v_row_map || jsonb_build_object(e ->> 'row_key', v_id::text);
  END LOOP;

  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_materialise -> 'batches', '[]'::jsonb)) LOOP
    SELECT id INTO v_id FROM public.mos_publish_batches WHERE plan_id = p_plan_id AND batch_key = e ->> 'key';
    IF v_id IS NULL THEN
      INSERT INTO public.mos_publish_batches (plan_id, campaign_id, execution_id, platform, day, sequence, batch_key, status)
      VALUES (p_plan_id, v_campaign, NULLIF(v_exec_map ->> (e ->> 'execution_key'), '')::uuid,
              e ->> 'platform', (e ->> 'day')::date, COALESCE((e ->> 'sequence')::int, 1), e ->> 'key', 'planned')
      RETURNING id INTO v_id;
      v_n_batch := v_n_batch + 1;
    END IF;
    v_batch_map := v_batch_map || jsonb_build_object(e ->> 'key', v_id::text);
  END LOOP;

  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_materialise -> 'cycles', '[]'::jsonb)) LOOP
    v_id := NULLIF(v_exec_map ->> (e ->> 'execution_key'), '')::uuid;
    IF v_id IS NULL THEN CONTINUE; END IF;
    INSERT INTO public.mos_refresh_cycles
      (execution_id, plan_id, round, refresh_on, ready_by, production_start_on, decision_due_on, status, decision)
    VALUES (v_id, p_plan_id, (e ->> 'round')::int,
            NULLIF(e ->> 'refresh_on','')::date, NULLIF(e ->> 'ready_by','')::date,
            NULLIF(e ->> 'production_start_on','')::date, NULLIF(e ->> 'decision_due_on','')::date,
            'scheduled',
            jsonb_build_object('produced', COALESCE((e ->> 'produced')::int, 0), 'banked_spare_slot_id', e ->> 'banked_spare_slot_id'))
    ON CONFLICT (execution_id, round) DO UPDATE
      SET plan_id = EXCLUDED.plan_id, refresh_on = EXCLUDED.refresh_on, ready_by = EXCLUDED.ready_by,
          production_start_on = EXCLUDED.production_start_on, decision_due_on = EXCLUDED.decision_due_on
    RETURNING id INTO v_id;
    v_n_cycle := v_n_cycle + 1;
    v_cycle_map := v_cycle_map || jsonb_build_object((e ->> 'execution_key') || '#' || (e ->> 'round'), v_id::text);
    IF NULLIF(e ->> 'banked_spare_slot_id', '') IS NOT NULL THEN
      UPDATE public.mos_creative_slots SET bank_reserved_for_cycle_id = v_id
       WHERE id = (e ->> 'banked_spare_slot_id')::uuid AND status = 'ready' AND kind IN ('fifth','spare')
         AND bank_reserved_for_cycle_id IS NULL;
    END IF;
  END LOOP;

  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_materialise -> 'items', '[]'::jsonb)) LOOP
    v_id := NULL;
    -- A creative the CAMPAIGN already materialised (this plan, a replaced plan,
    -- or a shell the sweep created for a refresh cycle) is REUSED — a re-plan
    -- re-dates the record it already has, it never duplicates it (D3).
    SELECT cp.content_id INTO v_id
      FROM public.mos_content_plan cp LEFT JOIN public.mos_campaign_plans p ON p.id = cp.plan_id
     WHERE cp.content_key = it ->> 'key'
       AND (cp.plan_id = p_plan_id OR (v_campaign IS NOT NULL AND p.campaign_id = v_campaign))
     LIMIT 1;
    IF v_id IS NULL AND it -> 'slot' IS NOT NULL AND it -> 'slot' <> 'null'::jsonb THEN
      SELECT sl.content_id INTO v_id FROM public.mos_creative_slots sl
       WHERE sl.content_key = it ->> 'key' AND sl.content_id IS NOT NULL
         AND sl.execution_id = NULLIF(v_exec_map ->> (it -> 'slot' ->> 'execution_key'), '')::uuid
       LIMIT 1;
    END IF;

    IF v_id IS NULL THEN
      IF it -> 'slot' IS NOT NULL AND it -> 'slot' <> 'null'::jsonb
         AND COALESCE((it -> 'slot' ->> 'cycle_round')::int, 0) > 0 THEN
        v_id := NULL;   -- deferred shell: the sweep creates it at production_start_on
      ELSE
        SELECT ct.id, (SELECT wv.id FROM public.workflow_versions wv WHERE wv.workflow_id = ct.workflow_id ORDER BY wv.version_no DESC LIMIT 1)
          INTO v_ct, v_ver
          FROM public.mos_content_types ct WHERE ct.key = it ->> 'content_type_key' AND ct.archived_at IS NULL;
        IF v_ct IS NULL THEN
          RAISE EXCEPTION 'MOS:UNKNOWN_CONTENT_TYPE %', it ->> 'content_type_key' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        INSERT INTO public.mos_content
          (content_type_id, workflow_id, workflow_version_id, title, project_id, project_ids,
           campaign_id, purpose, target_publish_at, created_by_user_id, organic_platforms, row_id, row_order)
        SELECT v_ct, ct.workflow_id, v_ver, it ->> 'title',
               NULLIF(it ->> 'project_id', '')::uuid,
               CASE WHEN NULLIF(it ->> 'project_id', '') IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(it ->> 'project_id') END,
               v_campaign,
               CASE WHEN v_kind = 'paid' THEN 'paid' ELSE 'organic' END,
               NULLIF(it ->> 'need_at', '')::timestamptz, p_actor,
               CASE WHEN v_kind = 'paid' THEN '{}'::text[]
                    ELSE COALESCE((SELECT array_agg(DISTINCT pp ->> 'platform')
                                     FROM jsonb_array_elements(COALESCE(it -> 'placements','[]'::jsonb)) pp), '{}'::text[]) END,
               NULLIF(v_row_map ->> COALESCE(it ->> 'row_key', ''), '')::uuid,
               NULLIF(it ->> 'row_order', '')::int
          FROM public.mos_content_types ct WHERE ct.id = v_ct
        RETURNING id INTO v_id;
        v_n_items := v_n_items + 1;
      END IF;
    END IF;

    IF v_id IS NOT NULL THEN
      IF NULLIF(it ->> 'row_key', '') IS NOT NULL THEN
        UPDATE public.mos_content
           SET row_id = NULLIF(v_row_map ->> (it ->> 'row_key'), '')::uuid,
               row_order = NULLIF(it ->> 'row_order', '')::int, updated_at = now()
         WHERE id = v_id
           AND (row_id IS DISTINCT FROM NULLIF(v_row_map ->> (it ->> 'row_key'), '')::uuid
             OR row_order IS DISTINCT FROM NULLIF(it ->> 'row_order', '')::int);
      END IF;
      -- a reused paid creative follows the new plan's need/activation
      IF v_kind = 'paid' THEN
        UPDATE public.mos_content SET target_publish_at = NULLIF(it ->> 'need_at', '')::timestamptz, updated_at = now()
         WHERE id = v_id AND NULLIF(it ->> 'need_at', '') IS NOT NULL
           AND target_publish_at IS DISTINCT FROM NULLIF(it ->> 'need_at', '')::timestamptz;
      END IF;

      INSERT INTO public.mos_content_plan
        (content_id, plan_id, campaign_id, need_at, required_ready_at, production_start, priority, stage_deadlines, stage_assignees, status, content_key)
      VALUES (v_id, p_plan_id, v_campaign,
              NULLIF(it ->> 'need_at', '')::timestamptz, NULLIF(it ->> 'required_ready_at', '')::date,
              NULLIF(it ->> 'production_start', '')::date, COALESCE((it ->> 'priority')::int, 1000),
              COALESCE(it -> 'stage_deadlines', '{}'::jsonb), COALESCE(it -> 'stage_assignees', '{}'::jsonb),
              'planned', it ->> 'key')
      ON CONFLICT (content_id) DO UPDATE
        SET plan_id = EXCLUDED.plan_id, campaign_id = EXCLUDED.campaign_id,
            need_at = EXCLUDED.need_at, required_ready_at = EXCLUDED.required_ready_at,
            production_start = EXCLUDED.production_start, priority = EXCLUDED.priority,
            stage_deadlines = EXCLUDED.stage_deadlines, stage_assignees = EXCLUDED.stage_assignees,
            content_key = EXCLUDED.content_key,
            status = CASE WHEN mos_content_plan.status IN ('planned','at_risk','late') THEN 'planned' ELSE mos_content_plan.status END;

      IF v_kind <> 'paid' THEN
        SELECT count(*) INTO v_n_rel
          FROM jsonb_array_elements(COALESCE(p_materialise -> 'releases', '[]'::jsonb)) x
         WHERE x.value ->> 'item_key' = it ->> 'key' AND COALESCE(x.value ->> 'kind', 'organic') <> 'ad';
        IF v_n_rel = 0 THEN
          FOR pl IN SELECT * FROM jsonb_array_elements(COALESCE(it -> 'placements', '[]'::jsonb)) LOOP
            INSERT INTO public.mos_publications
              (content_id, platform, status, planned_at, execution_id, batch_id, grid_row, grid_col, campaign_id, scheduled_timezone)
            VALUES (v_id, pl ->> 'platform', 'planned', NULLIF(pl ->> 'planned_at', '')::timestamptz,
                    NULLIF(v_exec_map ->> (pl ->> 'execution_key'), '')::uuid,
                    NULLIF(v_batch_map ->> (pl ->> 'batch_key'), '')::uuid,
                    NULLIF(pl ->> 'grid_row', '')::int, NULLIF(pl ->> 'grid_col', '')::int, v_campaign, 'Asia/Riyadh')
            ON CONFLICT (content_id, platform, account_id, COALESCE(placement_variant, '')) DO NOTHING;
            IF FOUND THEN v_n_pub := v_n_pub + 1; END IF;
          END LOOP;
        ELSE
          FOR pl IN
            SELECT x.value FROM jsonb_array_elements(COALESCE(p_materialise -> 'releases', '[]'::jsonb)) x
             WHERE x.value ->> 'item_key' = it ->> 'key' AND COALESCE(x.value ->> 'kind', 'organic') <> 'ad'
             ORDER BY ((x.value ->> 'placement_variant') IS NOT DISTINCT FROM 'story'), x.value ->> 'key'
          LOOP
            v_variant  := NULLIF(pl ->> 'placement_variant', '');
            v_pair_key := NULLIF(pl ->> 'pair_id', '');
            v_pub_id   := NULL;
            SELECT pb.id INTO v_pub_id FROM public.mos_publications pb
             WHERE pb.content_id = v_id AND pb.platform = pl ->> 'platform'
               AND COALESCE(pb.placement_variant, '') = COALESCE(v_variant, '');
            IF v_pub_id IS NOT NULL THEN
              SELECT COALESCE(pb.pair_id, pb.id) INTO v_pair_uuid FROM public.mos_publications pb WHERE pb.id = v_pub_id;
              IF v_pair_key IS NOT NULL THEN
                v_pair_map := v_pair_map || jsonb_build_object(v_pair_key, v_pair_uuid::text);
                UPDATE public.mos_publications
                   SET pair_id = COALESCE(pair_id, v_pair_uuid), placement_variant = COALESCE(placement_variant, v_variant), updated_at = now()
                 WHERE id = v_pub_id AND (pair_id IS NULL OR placement_variant IS NULL);
              END IF;
              -- a re-plan moves the moment of an unpublished release
              UPDATE public.mos_publications SET planned_at = NULLIF(pl ->> 'planned_at', '')::timestamptz, updated_at = now()
               WHERE id = v_pub_id AND status = 'planned' AND NULLIF(pl ->> 'planned_at', '') IS NOT NULL
                 AND planned_at IS DISTINCT FROM NULLIF(pl ->> 'planned_at', '')::timestamptz;
            ELSE
              v_pub_id := gen_random_uuid();
              IF v_pair_key IS NULL THEN
                v_pair_uuid := NULL;
              ELSE
                v_pair_uuid := NULLIF(v_pair_map ->> v_pair_key, '')::uuid;
                IF v_pair_uuid IS NULL THEN
                  v_pair_uuid := v_pub_id;
                  v_pair_map  := v_pair_map || jsonb_build_object(v_pair_key, v_pub_id::text);
                END IF;
              END IF;
              v_pl := NULL;
              SELECT p2.value INTO v_pl FROM jsonb_array_elements(COALESCE(it -> 'placements', '[]'::jsonb)) p2
               WHERE p2.value ->> 'platform' = pl ->> 'platform'
                 AND (p2.value ->> 'day') IS NOT DISTINCT FROM (pl ->> 'day') LIMIT 1;
              v_pl := COALESCE(v_pl, '{}'::jsonb);
              INSERT INTO public.mos_publications
                (id, content_id, platform, account_id, status, planned_at, execution_id, batch_id, grid_row, grid_col,
                 campaign_id, scheduled_timezone, placement_variant, pair_id)
              VALUES (v_pub_id, v_id, pl ->> 'platform', NULLIF(pl ->> 'account_id', '')::uuid, 'planned',
                      NULLIF(pl ->> 'planned_at', '')::timestamptz,
                      NULLIF(v_exec_map ->> (pl ->> 'execution_key'), '')::uuid,
                      NULLIF(v_batch_map ->> (v_pl ->> 'batch_key'), '')::uuid,
                      NULLIF(v_pl ->> 'grid_row', '')::int, NULLIF(v_pl ->> 'grid_col', '')::int,
                      v_campaign, 'Asia/Riyadh', v_variant, v_pair_uuid)
              ON CONFLICT (content_id, platform, account_id, COALESCE(placement_variant, '')) DO NOTHING;
              IF FOUND THEN
                v_n_pub := v_n_pub + 1;
              ELSE
                SELECT pb.id, COALESCE(pb.pair_id, pb.id) INTO v_pub_id, v_pair_uuid FROM public.mos_publications pb
                 WHERE pb.content_id = v_id AND pb.platform = pl ->> 'platform'
                   AND COALESCE(pb.placement_variant, '') = COALESCE(v_variant, '');
                IF v_pair_key IS NOT NULL AND v_pub_id IS NOT NULL THEN
                  v_pair_map := v_pair_map || jsonb_build_object(v_pair_key, v_pair_uuid::text);
                END IF;
              END IF;
            END IF;
          END LOOP;
        END IF;
      END IF;
    END IF;

    v_item_map := v_item_map || jsonb_build_object(it ->> 'key', COALESCE(v_id::text, ''));

    IF it -> 'slot' IS NOT NULL AND it -> 'slot' <> 'null'::jsonb THEN
      INSERT INTO public.mos_creative_slots
        (execution_id, cycle_id, plan_id, slot_index, kind, status, content_id, content_key, activate_on)
      SELECT NULLIF(v_exec_map ->> (it -> 'slot' ->> 'execution_key'), '')::uuid,
             NULLIF(v_cycle_map ->> ((it -> 'slot' ->> 'execution_key') || '#' || (it -> 'slot' ->> 'cycle_round')), '')::uuid,
             p_plan_id, COALESCE((it -> 'slot' ->> 'slot_index')::int, 0), COALESCE(it -> 'slot' ->> 'kind', 'initial'),
             'reserved', v_id, it ->> 'key',
             (SELECT refresh_on FROM public.mos_refresh_cycles
               WHERE id = NULLIF(v_cycle_map ->> ((it -> 'slot' ->> 'execution_key') || '#' || (it -> 'slot' ->> 'cycle_round')), '')::uuid)
      WHERE NULLIF(v_exec_map ->> (it -> 'slot' ->> 'execution_key'), '') IS NOT NULL
      ON CONFLICT (cycle_id, slot_index) WHERE cycle_id IS NOT NULL DO UPDATE
        SET plan_id = EXCLUDED.plan_id,
            activate_on = COALESCE(EXCLUDED.activate_on, mos_creative_slots.activate_on),
            content_id = COALESCE(mos_creative_slots.content_id, EXCLUDED.content_id);
      IF FOUND THEN v_n_slot := v_n_slot + 1; END IF;
    END IF;
  END LOOP;

  -- rule 4: reservations — carried entries are re-pointed (bound → new dates,
  -- consumed → dates kept); everything else is inserted; the live-set unique
  -- index is the backstop, a within-plan duplicate is refused by name.
  v_idx := -1;
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_reservations, '[]'::jsonb)) LOOP
    v_idx := v_idx + 1;

    IF v_idx = ANY (v_carry_idx) THEN
      SELECT x.* INTO c FROM public.mos_plan_resolve_carry(v_campaign, p_plan_id, p_reservations, p_materialise) x WHERE x.idx = v_idx;
      IF c.res_status IN ('bound','reserved','stale') THEN
        -- an unstarted step takes the new dates (D16); a stale one is live again
        UPDATE public.mos_task_reservations
           SET plan_id = p_plan_id,
               status = CASE WHEN status = 'stale' THEN 'reserved' ELSE status END,
               planned_start = (e ->> 'planned_start')::date, planned_end = (e ->> 'planned_end')::date,
               weight = COALESCE((e ->> 'weight')::numeric, weight),
               assignee_user_id = COALESCE(NULLIF(e ->> 'assignee_user_id', '')::uuid, assignee_user_id),
               bucket = COALESCE(e ->> 'bucket', bucket), updated_at = now()
         WHERE id = c.reservation_id;
        UPDATE public.workflow_role_tasks t
           SET scheduled_start = (e ->> 'planned_start')::date, scheduled_end = (e ->> 'planned_end')::date,
               effort_days = GREATEST(COALESCE((e ->> 'weight')::numeric, t.effort_days, 1), 0.5),
               offered_to_user_id = NULL, offered_at = NULL, updated_at = now()
         WHERE t.id = c.res_task_id AND t.status = 'open' AND t.assignee_user_id IS NULL;
      ELSE
        UPDATE public.mos_task_reservations SET plan_id = p_plan_id, updated_at = now() WHERE id = c.reservation_id;
      END IF;
      v_n_kept := v_n_kept + 1;
      CONTINUE;
    END IF;

    v_row_id := NULLIF(v_row_map ->> COALESCE(e ->> 'row_key', ''), '')::uuid;
    IF NULLIF(e ->> 'row_key', '') IS NOT NULL AND v_row_id IS NULL THEN
      RAISE EXCEPTION 'MOS:UNKNOWN_ROW_KEY %', e ->> 'row_key' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NULLIF(e ->> 'row_key', '') IS NULL AND NOT (v_item_map ? COALESCE(e ->> 'item_key', '')) THEN
      RAISE EXCEPTION 'MOS:UNKNOWN_ITEM_KEY %', COALESCE(e ->> 'item_key', '(null)') USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_cycle_id := COALESCE(NULLIF(e ->> 'cycle_id', '')::uuid, NULLIF(v_cycle_map ->> COALESCE(e ->> 'cycle_key', ''), '')::uuid);
    v_res_cid  := CASE WHEN v_row_id IS NULL THEN NULLIF(v_item_map ->> (e ->> 'item_key'), '')::uuid END;
    IF v_res_cid IS NULL AND v_row_id IS NULL AND v_cycle_id IS NULL THEN
      RAISE EXCEPTION 'MOS:UNBINDABLE_RESERVATION %', COALESCE(e ->> 'item_key', '(null)')
        USING ERRCODE = 'invalid_parameter_value', HINT = 'a deferred paid reservation must carry cycle_key (execution_key#round) or cycle_id';
    END IF;

    -- a second entry for the same (subject, step) in ONE payload is a bug, refused by name
    v_subj_key := COALESCE(v_res_cid::text, v_row_id::text, v_cycle_id::text || ':' || (e ->> 'item_key'));
    SELECT * INTO v_live FROM public.mos_task_reservations r
     WHERE r.step_key = e ->> 'step_key' AND r.status IN ('reserved','stale','bound','consumed')
       AND COALESCE(r.content_id::text, r.row_id::text, r.cycle_id::text || ':' || r.content_key) = v_subj_key
     LIMIT 1;
    IF FOUND THEN
      IF v_live.plan_id = p_plan_id THEN
        RAISE EXCEPTION 'MOS:PLAN_DUPLICATE_SUBJECT_STEP % %', v_subj_key, e ->> 'step_key' USING ERRCODE = 'raise_exception';
      END IF;
      -- a still-live booking of another plan for this subject+step that the
      -- carry pass did not claim (status reserved/stale): it had to be retired
      -- first — refuse loudly rather than silently re-point old dates
      RAISE EXCEPTION 'MOS:LIVE_BOOKING_NOT_RETIRED % % (plan %, status %)', v_subj_key, e ->> 'step_key', v_live.plan_id, v_live.status
        USING ERRCODE = 'WS409';
    END IF;

    INSERT INTO public.mos_task_reservations
      (plan_id, content_id, row_id, content_key, step_key, role_key, assignee_user_id, bucket,
       planned_start, planned_end, weight, status, cycle_id)
    VALUES (p_plan_id, v_res_cid, v_row_id, e ->> 'item_key', e ->> 'step_key', e ->> 'role_key',
            NULLIF(e ->> 'assignee_user_id', '')::uuid, COALESCE(e ->> 'bucket', 'post'),
            (e ->> 'planned_start')::date, (e ->> 'planned_end')::date,
            COALESCE((e ->> 'weight')::numeric, 1), 'reserved', v_cycle_id);
    v_n_res := v_n_res + 1;
  END LOOP;

  -- carried tasks: planned handoff + deadline re-stamped through the one chain
  UPDATE public.workflow_role_tasks t
     SET plan_handoff_at = ch.plan_handoff_at, plan_due_at = ch.plan_due_at
    FROM public.mos_task_reservations r
    JOIN LATERAL (SELECT c2.plan_handoff_at, c2.plan_due_at
                    FROM public.mos_plan_chain(CASE WHEN r.row_id IS NOT NULL THEN 'mos_content_rows' ELSE 'mos_content' END,
                                               COALESCE(r.row_id, r.content_id)) c2
                   WHERE c2.step_key = r.step_key LIMIT 1) ch ON true
   WHERE r.plan_id = p_plan_id AND r.consumed_task_id = t.id AND t.status = 'open';

  IF v_campaign IS NOT NULL THEN
    UPDATE public.mos_campaigns
       SET plan_id = p_plan_id, requirements = COALESCE(v_plan.input, '{}'::jsonb),
           starts_on = COALESCE(v_rs, starts_on), ends_on = COALESCE(v_re, ends_on)
     WHERE id = v_campaign;
  END IF;

  UPDATE public.mos_campaign_plans
     SET status = 'approved', approved_at = now(), approved_by_user_id = p_actor,
         snapshot_hash = v_hash, campaign_id = COALESCE(campaign_id, v_campaign), updated_at = now()
   WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'already', false, 'plan_id', p_plan_id, 'campaign_id', v_campaign,
    'items', v_n_items, 'reservations', v_n_res, 'reservations_kept', v_n_kept,
    'batches', v_n_batch, 'publications', v_n_pub, 'slots', v_n_slot, 'cycles', v_n_cycle,
    'rows', v_n_rows, 'retired', v_retire, 'snapshot_hash', v_hash);
END $function$;

CREATE OR REPLACE FUNCTION public.mos_campaign_plan_commit_month(p_plans jsonb, p_expected_hash text, p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hash   text;
  v_out    jsonb := '[]'::jsonb;
  v_res    jsonb;
  e        jsonb;
  v_n      int := 0;
  v_pid    uuid; v_camp uuid; v_status text;
  v_carry_idx int[]; v_carry_ids uuid[]; v_kept_idx int[]; v_moved_ids uuid[]; v_moved uuid[] := '{}';
  v_union  jsonb := '[]'::jsonb;
  v_cells  jsonb;
  v_retire jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('approve_plan') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Phase 0
  PERFORM public.mos_ledger_lock();
  v_hash := public.mos_workload_snapshot_hash();
  IF p_expected_hash IS NOT NULL AND p_expected_hash <> v_hash THEN
    RAISE EXCEPTION 'plan_changed'
      USING ERRCODE = 'WS409',
            DETAIL  = jsonb_build_object('expected', p_expected_hash, 'actual', v_hash)::text,
            HINT    = 'the workload moved since the preview — re-plan the month';
  END IF;

  -- Phase 1: per committing PROPOSED plan — resolve, carry, retire (provenance per campaign)
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_plans, '[]'::jsonb)) LOOP
    v_pid := NULLIF(e ->> 'plan_id', '')::uuid;
    IF v_pid IS NULL THEN
      RAISE EXCEPTION 'MOS:PLAN_ID_REQUIRED' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT status, campaign_id INTO v_status, v_camp FROM public.mos_campaign_plans WHERE id = v_pid;
    CONTINUE WHEN v_status IS DISTINCT FROM 'proposed';
    v_camp := COALESCE(NULLIF(e -> 'materialise' ->> 'campaign_id', '')::uuid, v_camp);
    SELECT COALESCE(array_agg(x.idx), '{}'), COALESCE(array_agg(x.reservation_id), '{}'),
           COALESCE(array_agg(x.idx) FILTER (WHERE x.res_status = 'consumed'), '{}'),
           COALESCE(array_agg(x.reservation_id) FILTER (WHERE x.res_status <> 'consumed'), '{}')
      INTO v_carry_idx, v_carry_ids, v_kept_idx, v_moved_ids
      FROM public.mos_plan_resolve_carry(v_camp, v_pid, COALESCE(e -> 'reservations', '[]'::jsonb), COALESCE(e -> 'materialise', '{}'::jsonb)) x;
    v_retire := v_retire || jsonb_build_array(jsonb_build_object('plan_id', v_pid,
                  'result', public.mos_retire_superseded(v_camp, v_pid, v_pid, v_carry_ids)));
    v_union := v_union || public.mos_plan_proposed_minus(COALESCE(e -> 'reservations', '[]'::jsonb), v_kept_idx);
    v_moved := v_moved || v_moved_ids;
  END LOOP;

  -- Phase 2: ONE guard
  v_cells := public.mos_capacity_check(v_union, '[]'::jsonb, v_moved);
  IF jsonb_array_length(v_cells) > 0 THEN
    RAISE EXCEPTION 'capacity_conflict'
      USING ERRCODE = 'WS409', DETAIL = v_cells::text, HINT = 'the month would overbook these cells';
  END IF;

  -- Phase 3: inserts (batch mode: no second retire, no second guard)
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_plans, '[]'::jsonb)) LOOP
    v_res := public.mos_campaign_plan_commit(
      (e ->> 'plan_id')::uuid, COALESCE(e -> 'reservations', '[]'::jsonb), NULL,
      COALESCE(e -> 'materialise', '{}'::jsonb), p_actor, true);
    v_out := v_out || jsonb_build_array(jsonb_build_object('plan_id', e ->> 'plan_id', 'result', v_res));
    v_n := v_n + 1;
  END LOOP;

  -- the decider runs once for whatever the new bookings make due today
  PERFORM public.mos_refill_request(NULL);

  RETURN jsonb_build_object('ok', true, 'plans', v_n, 'snapshot_hash', v_hash, 'committed', v_out, 'retired', v_retire);
END $function$;

-- the pre-2026-09-22 two-argument overload would shadow nothing but confuses df; one signature only
DROP FUNCTION IF EXISTS public.mos_capacity_check(jsonb, jsonb);

COMMIT;
