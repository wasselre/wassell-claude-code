-- ============================================================================
-- Campaign planning — RPCs (2026-09-14, part 2 of 4)
-- ----------------------------------------------------------------------------
-- contract §2.4 + §7 addendum. Every function here that WRITES ledger rows
-- takes `pg_advisory_xact_lock(hashtext('mos_work_ledger'))` — the same lock
-- mos_campaign_plan_commit takes FIRST — so two approvals can never book the
-- same remaining capacity (plan §4.4).
--
-- NEVER raises SQLSTATE 40001 / 40P01. Optimistic conflicts are WS409, rate
-- limits WS429 (CLAUDE.md "Never raise SQLSTATE 40001/40P01"; PostgREST retries
-- 40001 forever and that is what caused every conflict storm).
--
-- Every function: SECURITY DEFINER + SET search_path TO 'public', then
-- REVOKE ALL … FROM PUBLIC, anon and an explicit GRANT (Supabase's default
-- privileges hand EXECUTE to anon, so revoking from PUBLIC alone is not enough).
--
-- Idempotent: CREATE OR REPLACE throughout.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 0. The ledger lock — one helper so every writer spells it the same way
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_ledger_lock()
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT pg_advisory_xact_lock(hashtext('mos_work_ledger'));
$$;

-- Direct table writes to the ledger's own inputs must take the lock too,
-- otherwise the advisory protocol has a hole. A trigger is used instead of
-- wrapper RPCs so NO writer can bypass it (contract §2.4: mos_manual_task_write
-- / capacity_config_save are "ledger writers"). Re-entrant: a transaction that
-- already holds the lock just re-acquires it.
CREATE OR REPLACE FUNCTION public.mos_tg_ledger_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mos_work_ledger'));
  RETURN NULL;  -- AFTER STATEMENT trigger
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mos_manual_tasks','mos_user_capacity','mos_holidays','mos_step_effort'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', t || '_ledger_lock', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION public.mos_tg_ledger_lock()',
      t || '_ledger_lock', t);
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. mos_workload_snapshot_hash — the fingerprint commit refuses to move past
-- ----------------------------------------------------------------------------
-- md5 over the ORDERED ledger rows + per-person caps + approved leaves +
-- holidays + step effort. Deterministic: same state → same string, always.
-- trim_scale() normalises numeric text so 1 and 1.0 hash the same.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_workload_snapshot_hash()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT md5(
       'L:' || COALESCE((SELECT string_agg(x, '|' ORDER BY x) FROM (
              SELECT l.user_id::text || ';' || l.day::text || ';' || l.bucket || ';' ||
                     l.source || ';' || COALESCE(l.ref_id::text, '') || ';' ||
                     trim_scale(l.weight)::text AS x
                FROM public.mos_work_ledger_v l) a), '')
    || ' C:' || COALESCE((SELECT string_agg(c.user_id::text || ';' || c.bucket || ';' ||
                                            trim_scale(c.daily_slots)::text, '|'
                                            ORDER BY c.user_id, c.bucket)
                            FROM public.mos_user_capacity c), '')
    || ' R:' || COALESCE((SELECT string_agg(r.key || ';' || rl.bucket || ';' || rl.daily_new_tasks::text, '|'
                                            ORDER BY r.key, rl.bucket)
                            FROM public.mos_role_load rl JOIN public.roles r ON r.id = rl.role_id), '')
    || ' V:' || COALESCE((SELECT string_agg(lv.user_id::text || ';' ||
                                            (lv.start_at AT TIME ZONE 'Asia/Riyadh')::date::text || ';' ||
                                            (lv.end_at   AT TIME ZONE 'Asia/Riyadh')::date::text, '|'
                                            ORDER BY lv.user_id, lv.start_at)
                            FROM public.mos_leaves lv WHERE lv.status = 'approved'), '')
    || ' H:' || COALESCE((SELECT string_agg(h.day::text, '|' ORDER BY h.day) FROM public.mos_holidays h), '')
    || ' E:' || COALESCE((SELECT string_agg(e.workflow_key || ';' || e.step_key || ';' || e.bucket || ';' ||
                                            trim_scale(e.working_days)::text, '|'
                                            ORDER BY e.workflow_key, e.step_key, e.bucket)
                            FROM public.mos_step_effort e), '')
    || ' W:' || array_to_string(public.mos_weekend_days(), ',')
  );
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. mos_plan_consume_reservation — the SWAP (plan §8.1)
-- ----------------------------------------------------------------------------
-- Reservation leaves the ledger and the task enters it IN THE SAME STATEMENT
-- SEQUENCE, under the lock. Never both, never neither.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_plan_consume_reservation(p_task_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_task public.workflow_role_tasks%ROWTYPE;
  v_res  public.mos_task_reservations%ROWTYPE;
  v_key  text;
  v_days numeric;
  v_deadline date;
BEGIN
  PERFORM public.mos_ledger_lock();

  SELECT * INTO v_task FROM public.workflow_role_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND OR v_task.status <> 'open' OR v_task.subject_table <> 'mos_content' THEN
    RETURN NULL;
  END IF;
  IF v_task.reservation_id IS NOT NULL THEN
    RETURN v_task.reservation_id;   -- idempotent: already swapped
  END IF;

  SELECT cp.content_key INTO v_key FROM public.mos_content_plan cp WHERE cp.content_id = v_task.subject_id;

  SELECT * INTO v_res
    FROM public.mos_task_reservations r
   WHERE r.status IN ('reserved','stale')
     AND r.step_key = v_task.step_key
     AND (r.content_id = v_task.subject_id
          OR (r.content_id IS NULL AND v_key IS NOT NULL AND r.content_key = v_key))
   ORDER BY (r.content_id IS NOT NULL) DESC, r.planned_start
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;   -- unplanned content: the caller falls back to today's placer
  END IF;

  -- `weight` IS the total effort in slot-days (the ledger view spreads it),
  -- so the task inherits it verbatim — never span × weight, which would square
  -- a multi-day step's cost the moment the task branch spread it again.
  v_days := GREATEST(v_res.weight, 0.5);

  SELECT (cp.stage_deadlines ->> v_task.step_key)::date INTO v_deadline
    FROM public.mos_content_plan cp WHERE cp.content_id = v_task.subject_id;

  UPDATE public.mos_task_reservations
     SET status = 'consumed', consumed_task_id = v_task.id, content_id = v_task.subject_id, updated_at = now()
   WHERE id = v_res.id;

  UPDATE public.workflow_role_tasks
     SET assignee_user_id = COALESCE(v_res.assignee_user_id, assignee_user_id),
         scheduled_start  = v_res.planned_start,
         scheduled_end    = v_res.planned_end,
         effort_days      = v_days,
         reservation_id   = v_res.id,
         bucket           = COALESCE(bucket, v_res.bucket),
         -- plan §4.3 rule 3b: the due date respects the EFFORT, not a one-day SLA.
         due_at           = LEAST(
                              (LEAST(COALESCE(v_deadline, v_res.planned_end), v_res.planned_end)
                                 + interval '1 day' - interval '1 second')
                                AT TIME ZONE 'Asia/Riyadh',
                              (v_res.planned_end + interval '1 day' - interval '1 second')
                                AT TIME ZONE 'Asia/Riyadh')
   WHERE id = v_task.id;

  RETURN v_res.id;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. mos_plan_release — the work no longer needs doing (plan §8.4)
-- ────────────────────────────────────────────────────────────────────────────

-- Two entry points on purpose. The TRIGGER path must never refuse: a writer
-- archiving their own content would otherwise be blocked by a capability they
-- do not need. The RPC path is gated.
CREATE OR REPLACE FUNCTION public.mos_plan_release_internal(p_content_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_n integer; v_key text;
BEGIN
  PERFORM public.mos_ledger_lock();
  SELECT content_key INTO v_key FROM public.mos_content_plan WHERE content_id = p_content_id;
  UPDATE public.mos_task_reservations r
     SET status = 'released', updated_at = now()
   WHERE r.status IN ('reserved','stale')
     AND (r.content_id = p_content_id
          OR (r.content_id IS NULL AND v_key IS NOT NULL AND r.content_key = v_key));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN COALESCE(v_n, 0);
END $$;

CREATE OR REPLACE FUNCTION public.mos_plan_release(p_content_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('plan_campaign') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.mos_plan_release_internal(p_content_id);
END $$;

-- Release automatically when the content stops needing doing.
CREATE OR REPLACE FUNCTION public.mos_tg_release_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.mos_plan_release_internal(OLD.id);
    RETURN OLD;
  END IF;
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    PERFORM public.mos_plan_release_internal(NEW.id);
  ELSIF NEW.rejected_at IS NOT NULL AND OLD.rejected_at IS NULL THEN
    PERFORM public.mos_plan_release_internal(NEW.id);
  ELSIF NEW.on_hold_at IS NOT NULL AND OLD.on_hold_at IS NULL THEN
    PERFORM public.mos_plan_release_internal(NEW.id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mos_content_release_reservations_tg ON public.mos_content;
CREATE TRIGGER mos_content_release_reservations_tg
  AFTER UPDATE OR DELETE ON public.mos_content
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_release_reservations();

-- ────────────────────────────────────────────────────────────────────────────
-- 4. mos_campaign_plan_commit (contract §2.4 + §7 addendum)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_campaign_plan_commit(
  p_plan_id      uuid,
  p_reservations jsonb,
  p_expected_hash text,
  p_materialise  jsonb,
  p_actor        uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  v_n_batch  int := 0;
  v_n_pub    int := 0;
  v_n_slot   int := 0;
  v_n_cycle  int := 0;
BEGIN
  -- Capability gate. The API checks `approve_plan` too, but this RPC is
  -- reachable straight through PostgREST, so the check has to live here as
  -- well. auth.uid() IS NULL means service_role (anon is revoked below).
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('approve_plan') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- (a) THE LOCK, FIRST. Everything below is serialised against every other
  --     ledger writer, so the hash check and the capacity re-check see a state
  --     that cannot move under them.
  PERFORM public.mos_ledger_lock();

  SELECT * INTO v_plan FROM public.mos_campaign_plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:PLAN_NOT_FOUND %', p_plan_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Idempotent: an already-approved plan reports what it created and writes
  -- nothing. (The API short-circuits too; this must be safe on its own.)
  IF v_plan.status = 'approved' THEN
    RETURN jsonb_build_object(
      'already', true,
      'plan_id', p_plan_id,
      'items',        (SELECT count(*) FROM public.mos_content_plan      WHERE plan_id = p_plan_id),
      'reservations', (SELECT count(*) FROM public.mos_task_reservations WHERE plan_id = p_plan_id),
      'batches',      (SELECT count(*) FROM public.mos_publish_batches   WHERE plan_id = p_plan_id),
      'publications', (SELECT count(*) FROM public.mos_publications p
                        JOIN public.mos_publish_batches b ON b.id = p.batch_id WHERE b.plan_id = p_plan_id),
      'slots',        (SELECT count(*) FROM public.mos_creative_slots    WHERE plan_id = p_plan_id),
      'cycles',       (SELECT count(*) FROM public.mos_refresh_cycles    WHERE plan_id = p_plan_id));
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

  -- (c) INDEPENDENT SQL capacity re-check. Does not trust the TS arithmetic.
  -- `weight` is the reservation's TOTAL effort, so it must be spread by the
  -- SAME mos_spread_effort() the ledger view uses — one slot per working day,
  -- [1, 1, …, remainder]. Emitting the scalar once per day of the window
  -- double-counted every multi-day step (3 two-day designs scored 6 on one day
  -- instead of 3) and produced a bogus WS409 capacity_conflict.
  WITH prop AS (
    SELECT (x ->> 'assignee_user_id')::uuid       AS uid,
           COALESCE(x ->> 'bucket', 'post')       AS bucket,
           (x ->> 'planned_start')::date          AS ps,
           COALESCE((x ->> 'weight')::numeric, 1) AS total
      FROM jsonb_array_elements(COALESCE(p_reservations, '[]'::jsonb)) x
     WHERE NULLIF(x ->> 'assignee_user_id', '') IS NOT NULL
  ), spread AS (
    SELECT prop.uid, prop.bucket, s.day, s.weight AS w
      FROM prop
      CROSS JOIN LATERAL public.mos_spread_effort(
            GREATEST(prop.ps, public.mos_perf_today()), prop.total) s
  ), agg AS (
    SELECT uid, bucket, day, sum(w) AS proposed FROM spread GROUP BY 1, 2, 3
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', a.uid, 'day', a.day, 'bucket', a.bucket,
           'existing', x.existing, 'proposed', a.proposed,
           'capacity', public.mos_user_daily_slots(a.uid, a.bucket),
           'on_leave', public.mos_on_leave(a.uid, a.day))), '[]'::jsonb)
    INTO v_cells
    FROM agg a
    CROSS JOIN LATERAL (SELECT COALESCE(sum(l.weight), 0) AS existing
                          FROM public.mos_work_ledger_v l
                         WHERE l.user_id = a.uid AND l.day = a.day AND l.bucket = a.bucket) x
   WHERE public.mos_on_leave(a.uid, a.day)
      OR (x.existing + a.proposed) > public.mos_user_daily_slots(a.uid, a.bucket);

  IF jsonb_array_length(v_cells) > 0 THEN
    RAISE EXCEPTION 'capacity_conflict'
      USING ERRCODE = 'WS409',
            DETAIL  = v_cells::text,
            HINT    = 'the plan would overbook these cells';
  END IF;

  -- (d) materialise ------------------------------------------------------
  v_campaign := NULLIF(p_materialise ->> 'campaign_id', '')::uuid;
  v_kind     := COALESCE(p_materialise ->> 'kind', 'organic');
  v_rs       := NULLIF(p_materialise ->> 'range_start', '')::date;
  v_re       := NULLIF(p_materialise ->> 'range_end', '')::date;
  v_campaign := COALESCE(v_campaign, v_plan.campaign_id);

  -- rule 1: one execution per executions[] entry
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_materialise -> 'executions', '[]'::jsonb)) LOOP
    v_id := NULLIF(e ->> 'execution_id', '')::uuid;
    IF v_id IS NULL AND v_campaign IS NOT NULL THEN
      SELECT id INTO v_id FROM public.mos_campaign_executions
       WHERE campaign_id = v_campaign AND platform = e ->> 'platform'
         AND COALESCE(label, '') = '' AND archived_at IS NULL
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

  -- rule 3 (batches first — publications reference them)
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_materialise -> 'batches', '[]'::jsonb)) LOOP
    SELECT id INTO v_id FROM public.mos_publish_batches
     WHERE plan_id = p_plan_id AND batch_key = e ->> 'key';
    IF v_id IS NULL THEN
      INSERT INTO public.mos_publish_batches
        (plan_id, campaign_id, execution_id, platform, day, sequence, batch_key, status)
      VALUES (p_plan_id, v_campaign,
              NULLIF(v_exec_map ->> (e ->> 'execution_key'), '')::uuid,
              e ->> 'platform', (e ->> 'day')::date,
              COALESCE((e ->> 'sequence')::int, 1), e ->> 'key', 'planned')
      RETURNING id INTO v_id;
      v_n_batch := v_n_batch + 1;
    END IF;
    v_batch_map := v_batch_map || jsonb_build_object(e ->> 'key', v_id::text);
  END LOOP;

  -- cycles (paid)
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_materialise -> 'cycles', '[]'::jsonb)) LOOP
    v_id := NULLIF(v_exec_map ->> (e ->> 'execution_key'), '')::uuid;
    IF v_id IS NULL THEN CONTINUE; END IF;
    INSERT INTO public.mos_refresh_cycles
      (execution_id, plan_id, round, refresh_on, ready_by, production_start_on, decision_due_on, status, decision)
    VALUES (v_id, p_plan_id, (e ->> 'round')::int,
            NULLIF(e ->> 'refresh_on','')::date, NULLIF(e ->> 'ready_by','')::date,
            NULLIF(e ->> 'production_start_on','')::date, NULLIF(e ->> 'decision_due_on','')::date,
            'scheduled',
            jsonb_build_object('produced', COALESCE((e ->> 'produced')::int, 0),
                               'banked_spare_slot_id', e ->> 'banked_spare_slot_id'))
    ON CONFLICT (execution_id, round) DO UPDATE
      SET plan_id = EXCLUDED.plan_id, refresh_on = EXCLUDED.refresh_on,
          ready_by = EXCLUDED.ready_by, production_start_on = EXCLUDED.production_start_on,
          decision_due_on = EXCLUDED.decision_due_on
    RETURNING id INTO v_id;
    v_n_cycle := v_n_cycle + 1;
    v_cycle_map := v_cycle_map || jsonb_build_object(
      (e ->> 'execution_key') || '#' || (e ->> 'round'), v_id::text);
    -- exclusive earmark of a banked spare (v2.1 correction 2); the partial
    -- unique index refuses a second cycle claiming the same slot.
    IF NULLIF(e ->> 'banked_spare_slot_id', '') IS NOT NULL THEN
      UPDATE public.mos_creative_slots
         SET bank_reserved_for_cycle_id = v_id
       WHERE id = (e ->> 'banked_spare_slot_id')::uuid
         AND status = 'ready' AND kind IN ('fifth','spare')
         AND bank_reserved_for_cycle_id IS NULL;
    END IF;
  END LOOP;

  -- rule 2 + 3: items → content shell (NOT the first task), plan row,
  -- publications (organic), creative slots (paid)
  FOR it IN SELECT * FROM jsonb_array_elements(COALESCE(p_materialise -> 'items', '[]'::jsonb)) LOOP
    v_id := NULL;

    -- Already materialised by an earlier attempt? (idempotence)
    SELECT content_id INTO v_id FROM public.mos_content_plan
     WHERE plan_id = p_plan_id AND content_key = it ->> 'key';

    IF v_id IS NULL THEN
      -- Paid slot items for LATER rounds are created lazily by the sweep at
      -- production_start_on; round 0 (launch) is created now.
      IF it -> 'slot' IS NOT NULL AND it -> 'slot' <> 'null'::jsonb
         AND COALESCE((it -> 'slot' ->> 'cycle_round')::int, 0) > 0 THEN
        v_id := NULL;   -- shell deferred
      ELSE
        SELECT ct.id,
               (SELECT wv.id FROM public.workflow_versions wv
                 WHERE wv.workflow_id = ct.workflow_id ORDER BY wv.version_no DESC LIMIT 1)
          INTO v_ct, v_ver
          FROM public.mos_content_types ct
         WHERE ct.key = it ->> 'content_type_key' AND ct.archived_at IS NULL;
        IF v_ct IS NULL THEN
          RAISE EXCEPTION 'MOS:UNKNOWN_CONTENT_TYPE %', it ->> 'content_type_key'
            USING ERRCODE = 'invalid_parameter_value';
        END IF;

        INSERT INTO public.mos_content
          (content_type_id, workflow_id, workflow_version_id, title, project_id, project_ids,
           campaign_id, purpose, target_publish_at, created_by_user_id, organic_platforms)
        SELECT v_ct, ct.workflow_id, v_ver, it ->> 'title',
               NULLIF(it ->> 'project_id', '')::uuid,
               CASE WHEN NULLIF(it ->> 'project_id', '') IS NULL THEN '[]'::jsonb
                    ELSE jsonb_build_array(it ->> 'project_id') END,
               v_campaign,
               CASE WHEN v_kind = 'paid' THEN 'paid' ELSE 'organic' END,
               NULLIF(it ->> 'need_at', '')::timestamptz, p_actor,
               CASE WHEN v_kind = 'paid' THEN '{}'::text[]
                    ELSE COALESCE((SELECT array_agg(DISTINCT pp ->> 'platform')
                                     FROM jsonb_array_elements(COALESCE(it -> 'placements','[]'::jsonb)) pp),
                                  '{}'::text[]) END
          FROM public.mos_content_types ct WHERE ct.id = v_ct
        RETURNING id INTO v_id;
        v_n_items := v_n_items + 1;
      END IF;
    END IF;

    IF v_id IS NOT NULL THEN
      INSERT INTO public.mos_content_plan
        (content_id, plan_id, campaign_id, need_at, required_ready_at, production_start,
         priority, stage_deadlines, stage_assignees, status, content_key)
      VALUES (v_id, p_plan_id, v_campaign,
              NULLIF(it ->> 'need_at', '')::timestamptz,
              NULLIF(it ->> 'required_ready_at', '')::date,
              NULLIF(it ->> 'production_start', '')::date,
              COALESCE((it ->> 'priority')::int, 1000),
              COALESCE(it -> 'stage_deadlines', '{}'::jsonb),
              COALESCE(it -> 'stage_assignees', '{}'::jsonb),
              'planned', it ->> 'key')
      ON CONFLICT (content_id) DO UPDATE
        SET plan_id = EXCLUDED.plan_id, campaign_id = EXCLUDED.campaign_id,
            need_at = EXCLUDED.need_at, required_ready_at = EXCLUDED.required_ready_at,
            production_start = EXCLUDED.production_start, priority = EXCLUDED.priority,
            stage_deadlines = EXCLUDED.stage_deadlines, stage_assignees = EXCLUDED.stage_assignees,
            content_key = EXCLUDED.content_key;

      IF v_kind <> 'paid' THEN
        FOR pl IN SELECT * FROM jsonb_array_elements(COALESCE(it -> 'placements', '[]'::jsonb)) LOOP
          INSERT INTO public.mos_publications
            (content_id, platform, status, planned_at, execution_id, batch_id,
             grid_row, grid_col, campaign_id, scheduled_timezone)
          VALUES (v_id, pl ->> 'platform', 'planned',
                  NULLIF(pl ->> 'planned_at', '')::timestamptz,
                  NULLIF(v_exec_map ->> (pl ->> 'execution_key'), '')::uuid,
                  NULLIF(v_batch_map ->> (pl ->> 'batch_key'), '')::uuid,
                  NULLIF(pl ->> 'grid_row', '')::int,
                  NULLIF(pl ->> 'grid_col', '')::int,
                  v_campaign, 'Asia/Riyadh')
          ON CONFLICT (content_id, platform, account_id) DO NOTHING;
          v_n_pub := v_n_pub + 1;
        END LOOP;
      END IF;
    END IF;

    v_item_map := v_item_map || jsonb_build_object(it ->> 'key', COALESCE(v_id::text, ''));

    -- paid creative slot
    IF it -> 'slot' IS NOT NULL AND it -> 'slot' <> 'null'::jsonb THEN
      INSERT INTO public.mos_creative_slots
        (execution_id, cycle_id, plan_id, slot_index, kind, status, content_id, content_key, activate_on)
      SELECT NULLIF(v_exec_map ->> (it -> 'slot' ->> 'execution_key'), '')::uuid,
             NULLIF(v_cycle_map ->> ((it -> 'slot' ->> 'execution_key') || '#' || (it -> 'slot' ->> 'cycle_round')), '')::uuid,
             p_plan_id,
             COALESCE((it -> 'slot' ->> 'slot_index')::int, 0),
             COALESCE(it -> 'slot' ->> 'kind', 'initial'),
             'reserved', v_id, it ->> 'key',
             (SELECT refresh_on FROM public.mos_refresh_cycles
               WHERE id = NULLIF(v_cycle_map ->> ((it -> 'slot' ->> 'execution_key') || '#' || (it -> 'slot' ->> 'cycle_round')), '')::uuid)
      WHERE NULLIF(v_exec_map ->> (it -> 'slot' ->> 'execution_key'), '') IS NOT NULL
      ON CONFLICT (cycle_id, slot_index) WHERE cycle_id IS NOT NULL DO NOTHING;
      v_n_slot := v_n_slot + 1;
    END IF;
  END LOOP;

  -- rule 4: reservations
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_reservations, '[]'::jsonb)) LOOP
    INSERT INTO public.mos_task_reservations
      (plan_id, content_id, content_key, step_key, role_key, assignee_user_id, bucket,
       planned_start, planned_end, weight, status,
       cycle_id)
    VALUES (p_plan_id,
            NULLIF(v_item_map ->> (e ->> 'item_key'), '')::uuid,
            e ->> 'item_key',
            e ->> 'step_key', e ->> 'role_key',
            NULLIF(e ->> 'assignee_user_id', '')::uuid,
            COALESCE(e ->> 'bucket', 'post'),
            (e ->> 'planned_start')::date, (e ->> 'planned_end')::date,
            COALESCE((e ->> 'weight')::numeric, 1), 'reserved',
            NULLIF(e ->> 'cycle_id', '')::uuid);
    v_n_res := v_n_res + 1;
  END LOOP;

  -- rule 5
  IF v_campaign IS NOT NULL THEN
    UPDATE public.mos_campaigns
       SET plan_id      = p_plan_id,
           requirements = COALESCE(v_plan.input, '{}'::jsonb),
           starts_on    = COALESCE(v_rs, starts_on),
           ends_on      = COALESCE(v_re, ends_on)
     WHERE id = v_campaign;
  END IF;

  UPDATE public.mos_campaign_plans
     SET status = 'superseded', superseded_by = p_plan_id, updated_at = now()
   WHERE campaign_id = v_campaign AND campaign_id IS NOT NULL
     AND id <> p_plan_id AND status IN ('proposed','approved');

  UPDATE public.mos_campaign_plans
     SET status = 'approved', approved_at = now(), approved_by_user_id = p_actor,
         snapshot_hash = v_hash, campaign_id = COALESCE(campaign_id, v_campaign), updated_at = now()
   WHERE id = p_plan_id;

  RETURN jsonb_build_object(
    'already', false, 'plan_id', p_plan_id, 'campaign_id', v_campaign,
    'items', v_n_items, 'reservations', v_n_res, 'batches', v_n_batch,
    'publications', v_n_pub, 'slots', v_n_slot, 'cycles', v_n_cycle,
    'snapshot_hash', v_hash);
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5. mos_plan_start_due — the 10-minute sweep's opener
-- ----------------------------------------------------------------------------
-- Idempotent by construction: every branch is guarded by a NOT EXISTS on an
-- open task / an already-linked shell, never by catching a unique violation.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_plan_start_due()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_today   date := public.mos_perf_today();
  r         record;
  v_started int := 0;
  v_shells  int := 0;
  v_cycles  int := 0;
  v_ct      uuid;
  v_ver     uuid;
  v_new     uuid;
BEGIN
  PERFORM public.mos_ledger_lock();

  -- (1) planned content whose production start has arrived
  FOR r IN
    SELECT cp.content_id
      FROM public.mos_content_plan cp
      JOIN public.mos_content c ON c.id = cp.content_id AND c.archived_at IS NULL
                               AND c.on_hold_at IS NULL AND c.rejected_at IS NULL
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

  -- Content that already has a task but whose plan row still says 'planned'
  -- (started early by hand) — keep the two in step.
  UPDATE public.mos_content_plan cp
     SET status = 'in_production'
   WHERE cp.status = 'planned'
     AND EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                  WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id);

  -- (2) refresh cycles whose production start has arrived: create the shells
  --     for their reserved slots, then open the first task.
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
      DECLARE s record;
      BEGIN
        FOR s IN
          SELECT sl.id, sl.slot_index, sl.kind
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
           WHERE content_id IS NULL AND cycle_id = r.cycle_id
             AND content_key IS NOT NULL
             AND content_key = (SELECT content_key FROM public.mos_creative_slots WHERE id = s.id);

          IF NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                          WHERE t.subject_table = 'mos_content' AND t.subject_id = v_new) THEN
            PERFORM public.workflow_role_path_start('mos_content', v_new);
            v_started := v_started + 1;
          END IF;
          v_shells := v_shells + 1;
        END LOOP;
      END;
    END IF;

    UPDATE public.mos_refresh_cycles SET status = 'producing' WHERE id = r.cycle_id AND status = 'scheduled';
    v_cycles := v_cycles + 1;
  END LOOP;

  RETURN jsonb_build_object('started', v_started, 'shells_created', v_shells, 'cycles_started', v_cycles);
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 6. mos_plan_repair — the 10-minute reconciliation (plan §8.3)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_plan_repair(p_campaign_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_today    date := public.mos_perf_today();
  v_staled   int := 0;
  v_redated  int := 0;
  v_at_risk  int := 0;
  v_late     int := 0;
  v_batches  int := 0;
  r          record;
  v_span     int;
  v_start    date;
  v_end      date;
BEGIN
  PERFORM public.mos_ledger_lock();

  -- (a) a reservation whose window has passed and whose step never opened is
  --     STALE — still in the ledger at full weight, projected from today.
  UPDATE public.mos_task_reservations res
     SET status = 'stale', updated_at = now()
   WHERE res.status = 'reserved'
     AND res.planned_end < v_today
     AND res.consumed_task_id IS NULL
     AND (p_campaign_id IS NULL
          OR EXISTS (SELECT 1 FROM public.mos_content_plan cp
                      WHERE cp.content_id = res.content_id AND cp.campaign_id = p_campaign_id));
  GET DIAGNOSTICS v_staled = ROW_COUNT;

  -- (b) re-date the stale ones forward, preserving their span. (The full
  --     re-plan is the API's repair mode; this keeps the LEDGER honest.)
  FOR r IN
    SELECT res.id, res.planned_start, res.planned_end
      FROM public.mos_task_reservations res
     WHERE res.status = 'stale'
       AND (p_campaign_id IS NULL
            OR EXISTS (SELECT 1 FROM public.mos_content_plan cp
                        WHERE cp.content_id = res.content_id AND cp.campaign_id = p_campaign_id))
  LOOP
    -- the span is the EFFORT, in working days — not the calendar width of the
    -- old window (a window can be wider than its effort after a repair).
    v_span := GREATEST(ceil((SELECT weight FROM public.mos_task_reservations WHERE id = r.id))::int, 1);
    SELECT min(d), max(d) INTO v_start, v_end
      FROM public.mos_working_days_from(v_today, v_span) d;
    UPDATE public.mos_task_reservations
       SET planned_start = v_start, planned_end = v_end, status = 'reserved', updated_at = now()
     WHERE id = r.id;
    v_redated := v_redated + 1;
  END LOOP;

  -- (c) production plans: late when the ready date has passed unmet; at_risk
  --     when an open task is past its stage deadline.
  UPDATE public.mos_content_plan cp
     SET status = 'late'
   WHERE cp.status IN ('planned','in_production','at_risk')
     AND cp.required_ready_at IS NOT NULL AND cp.required_ready_at < v_today
     AND (p_campaign_id IS NULL OR cp.campaign_id = p_campaign_id);
  GET DIAGNOSTICS v_late = ROW_COUNT;

  UPDATE public.mos_content_plan cp
     SET status = 'at_risk'
   WHERE cp.status IN ('planned','in_production')
     AND (p_campaign_id IS NULL OR cp.campaign_id = p_campaign_id)
     AND EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                  WHERE t.subject_table = 'mos_content' AND t.subject_id = cp.content_id
                    AND t.status = 'open'
                    AND (cp.stage_deadlines ->> t.step_key)::date IS NOT NULL
                    AND (cp.stage_deadlines ->> t.step_key)::date < v_today);
  GET DIAGNOSTICS v_at_risk = ROW_COUNT;

  -- (d) batches take the rollup's verdict
  UPDATE public.mos_publish_batches b
     SET status = v.risk
    FROM public.mos_publish_batch_v v
   WHERE v.id = b.id AND b.status <> v.risk
     AND v.risk IN ('planned','on_track','at_risk','late','done')
     AND (p_campaign_id IS NULL OR b.campaign_id = p_campaign_id);
  GET DIAGNOSTICS v_batches = ROW_COUNT;

  RETURN jsonb_build_object('staled', v_staled, 'redated', v_redated,
                            'at_risk', v_at_risk, 'late', v_late, 'batches', v_batches);
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7. Package hashes — what exactly was approved (plan §9.3)
-- ────────────────────────────────────────────────────────────────────────────

-- Writing fields = every field_schema key that is NOT the caption/hashtags/notes.
CREATE OR REPLACE FUNCTION public.mos_content_writing_hash(p_content_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT md5(COALESCE((
    SELECT string_agg(k || '=' || COALESCE(c.data ->> k, ''), '|' ORDER BY k)
      FROM public.mos_content c
      JOIN public.mos_content_types ct ON ct.id = c.content_type_id
      CROSS JOIN LATERAL (
        SELECT DISTINCT COALESCE(f ->> 'key', f #>> '{}') AS k
          FROM jsonb_array_elements(COALESCE(ct.field_schema, '[]'::jsonb)) f) fk
     WHERE c.id = p_content_id
       AND fk.k IS NOT NULL
       AND fk.k NOT IN ('caption','hashtags','notes','caption_confirmed_text','caption_confirmed_at',
                        'caption_confirmed_hash','caption_confirmed_by_writer_at')
  ), '')
  || '#' || COALESCE((SELECT c.title FROM public.mos_content c WHERE c.id = p_content_id), ''));
$$;

CREATE OR REPLACE FUNCTION public.mos_content_design_hash(p_content_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT md5(COALESCE((
    SELECT string_agg(al.role || '=' || al.asset_id::text || ':' || al.version::text, '|' ORDER BY al.role)
      FROM public.mos_asset_links al
     WHERE al.content_id = p_content_id
       AND al.superseded_at IS NULL
       AND al.role IN ('final','final_square','final_vertical')), ''));
$$;

CREATE OR REPLACE FUNCTION public.mos_content_package_hash(p_content_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT md5(public.mos_content_writing_hash(p_content_id) || '#' ||
             public.mos_content_design_hash(p_content_id) || '#' ||
             COALESCE(public.mos_caption_hash((SELECT data ->> 'caption' FROM public.mos_content WHERE id = p_content_id)), ''));
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 8. content_ad_readiness (contract §4 blocker codes)
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.content_ad_readiness(p_content_id uuid, p_execution_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_c       public.mos_content%ROWTYPE;
  v_ex      public.mos_campaign_executions%ROWTYPE;
  v_b       jsonb := '[]'::jsonb;
  v_sq      uuid;
  v_ve      uuid;
  v_sqk     text;
  v_vek     text;
  v_dest    text;
  v_budget  numeric;
  v_slate   int;
  v_active  int;
  v_aud     text;
BEGIN
  SELECT * INTO v_c FROM public.mos_content WHERE id = p_content_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:CONTENT_NOT_FOUND %', p_content_id USING ERRCODE = 'no_data_found';
  END IF;

  -- ── design slots ────────────────────────────────────────────────────────
  SELECT al.asset_id INTO v_sq FROM public.mos_asset_links al
   WHERE al.content_id = p_content_id AND al.role = 'final_square' AND al.superseded_at IS NULL;
  SELECT al.asset_id INTO v_ve FROM public.mos_asset_links al
   WHERE al.content_id = p_content_id AND al.role = 'final_vertical' AND al.superseded_at IS NULL;

  IF v_sq IS NULL THEN
    v_b := v_b || jsonb_build_object('code','final_square',
      'label_ar','ينقص التصميم المربّع (١:١ للفيد)','label_en','The square 1:1 design (feed) is missing');
  END IF;
  IF v_ve IS NULL THEN
    v_b := v_b || jsonb_build_object('code','final_vertical',
      'label_ar','ينقص التصميم الطولي (٩:١٦ للستوري والريلز)','label_en','The vertical 9:16 design (stories / reels) is missing');
  END IF;
  IF v_sq IS NOT NULL AND v_ve IS NOT NULL THEN
    SELECT CASE WHEN a.kind = 'video' OR COALESCE(a.mime_type,'') LIKE 'video/%' THEN 'video' ELSE 'image' END
      INTO v_sqk FROM public.mos_assets a WHERE a.id = v_sq;
    SELECT CASE WHEN a.kind = 'video' OR COALESCE(a.mime_type,'') LIKE 'video/%' THEN 'video' ELSE 'image' END
      INTO v_vek FROM public.mos_assets a WHERE a.id = v_ve;
    IF v_sqk IS DISTINCT FROM v_vek THEN
      v_b := v_b || jsonb_build_object('code','slots_same_kind',
        'label_ar','التصميمان من نوعين مختلفين (صورة وفيديو) — يجب أن يكونا من النوع نفسه',
        'label_en','The two slots are different media kinds (image vs video) — they must match');
    END IF;
  END IF;

  -- ── caption ─────────────────────────────────────────────────────────────
  -- EXACT string comparison against caption_confirmed_text -- the same rule
  -- workflow_advance_role_path enforces and mos_content_v exposes. ONE rule.
  IF NULLIF(v_c.data ->> 'caption', '') IS NULL
     OR v_c.data ->> 'caption_confirmed_text' IS DISTINCT FROM v_c.data ->> 'caption' THEN
    v_b := v_b || jsonb_build_object('code','caption_approved',
      'label_ar','النص الإعلاني غير مؤكَّد على نسخته الحالية','label_en','The caption is not confirmed for its current version');
  END IF;

  -- ── links ───────────────────────────────────────────────────────────────
  IF v_c.project_id IS NULL AND COALESCE(jsonb_array_length(v_c.project_ids), 0) = 0 THEN
    v_b := v_b || jsonb_build_object('code','project_linked',
      'label_ar','المحتوى غير مرتبط بمشروع','label_en','The content is not linked to a project');
  END IF;
  IF v_c.campaign_id IS NULL THEN
    v_b := v_b || jsonb_build_object('code','campaign_linked',
      'label_ar','المحتوى غير مرتبط بحملة','label_en','The content is not linked to a campaign');
  END IF;

  -- ── the paid child ──────────────────────────────────────────────────────
  IF p_execution_id IS NOT NULL THEN
    SELECT * INTO v_ex FROM public.mos_campaign_executions WHERE id = p_execution_id;
  ELSIF v_c.campaign_id IS NOT NULL THEN
    SELECT * INTO v_ex FROM public.mos_campaign_executions
     WHERE campaign_id = v_c.campaign_id AND platform = 'meta' AND archived_at IS NULL
     ORDER BY created_at LIMIT 1;
  END IF;

  IF v_ex.id IS NULL THEN
    v_b := v_b || jsonb_build_object('code','meta_execution_linked',
      'label_ar','لا توجد حملة ميتا فرعية مرتبطة','label_en','No Meta child campaign is linked');
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.mos_ad_sets s
                    WHERE s.execution_id = v_ex.id AND s.archived_at IS NULL) THEN
      v_b := v_b || jsonb_build_object('code','ad_set_linked',
        'label_ar','لا توجد مجموعة إعلانية في الحملة الفرعية','label_en','The child campaign has no ad set');
    ELSIF EXISTS (SELECT 1 FROM public.mos_ad_sets s
                   WHERE s.execution_id = v_ex.id AND s.archived_at IS NULL
                     AND s.placement_variant = 'feed' AND s.pair_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM public.mos_ad_sets s2
                                      WHERE s2.pair_id = s.pair_id AND s2.placement_variant = 'story'
                                        AND s2.archived_at IS NULL)) THEN
      v_b := v_b || jsonb_build_object('code','ad_set_pair_complete',
        'label_ar','مجموعة الستوري المرافقة غير موجودة','label_en','The paired story ad set is missing');
    END IF;

    v_budget := COALESCE(v_ex.budget,
                         (v_ex.platform_settings ->> 'daily_budget')::numeric,
                         (v_ex.platform_settings ->> 'lifetime_budget')::numeric);
    IF COALESCE(v_budget, 0) <= 0 THEN
      v_b := v_b || jsonb_build_object('code','budget_set',
        'label_ar','لم تُحدَّد ميزانية للحملة الفرعية','label_en','The child campaign has no budget');
    END IF;

    v_dest := v_ex.platform_settings ->> 'destination_type';
    IF NULLIF(v_dest, '') IS NULL THEN
      v_b := v_b || jsonb_build_object('code','destination_valid',
        'label_ar','وجهة الإعلان غير محددة','label_en','The ad destination is not set');
    ELSIF v_dest = 'WEBSITE'
          AND NULLIF((SELECT destination_url FROM public.mos_campaigns WHERE id = v_ex.campaign_id), '') IS NULL THEN
      v_b := v_b || jsonb_build_object('code','destination_valid',
        'label_ar','وجهة الإعلان موقع إلكتروني بدون رابط','label_en','Website destination with no URL');
    END IF;

    -- The welcome template is duplicated at build time from an existing
    -- Click-to-WhatsApp ad in the account; the DB can only see whether such an
    -- ad exists. APPROXIMATE by design — the worker re-checks against Meta.
    IF v_dest = 'WHATSAPP'
       AND NOT EXISTS (SELECT 1 FROM public.mos_execution_ads a
                        WHERE a.archived_at IS NULL
                          AND a.creative ->> 'cta' = 'WHATSAPP_MESSAGE') THEN
      v_b := v_b || jsonb_build_object('code','welcome_template',
        'label_ar','لا يوجد إعلان واتساب سابق لنسخ رسالة الترحيب منه','label_en','No existing WhatsApp ad to duplicate the welcome message from');
    END IF;

    -- Slate: an ad may only be built when this content holds a slot, or the
    -- slate still has room (§7.3).
    v_slate := COALESCE((v_ex.refresh_policy ->> 'slate_size')::int,
                        ((SELECT value FROM public.mos_settings WHERE key = 'refresh_policy') ->> 'slate_size')::int,
                        5);
    SELECT count(*) INTO v_active FROM public.mos_creative_slots sl
     WHERE sl.execution_id = v_ex.id AND sl.status IN ('active','ready','producing','reserved');
    IF NOT EXISTS (SELECT 1 FROM public.mos_creative_slots sl
                    WHERE sl.execution_id = v_ex.id AND sl.content_id = p_content_id
                      AND sl.status <> 'released')
       AND v_active >= v_slate THEN
      v_b := v_b || jsonb_build_object('code','creative_slot_available',
        'label_ar','لا توجد خانة إبداعية شاغرة في هذه الحملة الفرعية','label_en','No free creative slot on this child campaign');
    END IF;
  END IF;

  -- ── saved audience ──────────────────────────────────────────────────────
  SELECT COALESCE(
           (SELECT a.meta_saved_audience_id FROM public.mos_audiences a
             JOIN public.mos_campaigns cm ON cm.audience_id = a.id
            WHERE cm.id = v_c.campaign_id),
           ((SELECT value FROM public.mos_settings WHERE key = 'meta_push') ->> 'saved_audience_id'))
    INTO v_aud;
  IF NULLIF(v_aud, '') IS NULL THEN
    v_b := v_b || jsonb_build_object('code','saved_audience',
      'label_ar','لا توجد شريحة جمهور محفوظة','label_en','No saved audience is configured');
  END IF;

  RETURN jsonb_build_object('ok', jsonb_array_length(v_b) = 0, 'blockers', v_b,
                            'content_id', p_content_id, 'execution_id', v_ex.id);
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 9. mos_campaign_rollup — parent totals, DISTINCT by content id
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_campaign_rollup(p_campaign_id uuid, p_execution_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH ex AS (
    SELECT e.* FROM public.mos_campaign_executions e
     WHERE e.campaign_id = p_campaign_id AND e.archived_at IS NULL
       AND (p_execution_id IS NULL OR e.id = p_execution_id)
  ), ads AS (
    SELECT a.* FROM public.mos_execution_ads a
     JOIN ex ON ex.id = a.execution_id
    WHERE a.archived_at IS NULL
  ), pubs AS (
    SELECT p.* FROM public.mos_publications p
     WHERE (p.campaign_id = p_campaign_id
            OR p.execution_id IN (SELECT id FROM ex)
            OR p.content_id IN (SELECT id FROM public.mos_content WHERE campaign_id = p_campaign_id))
       AND (p_execution_id IS NULL OR p.execution_id = p_execution_id)
  ), content AS (
    -- provenance: content attached to the campaign, to one of its ads, or to
    -- one of its placements. DISTINCT by content id — never double-counted.
    SELECT DISTINCT id FROM (
      SELECT c.id FROM public.mos_content c
       WHERE c.campaign_id = p_campaign_id AND c.archived_at IS NULL
         AND p_execution_id IS NULL
      UNION
      SELECT a.content_id FROM ads a WHERE a.content_id IS NOT NULL
      UNION
      SELECT p.content_id FROM pubs p WHERE p.content_id IS NOT NULL) u
  )
  SELECT jsonb_build_object(
    'campaign_id',  p_campaign_id,
    'execution_id', p_execution_id,
    'content', jsonb_build_object(
      'total', (SELECT count(*) FROM content),
      'by_status', COALESCE((SELECT jsonb_object_agg(k, n) FROM (
                      SELECT COALESCE(v.status_key, 'draft') AS k, count(*) AS n
                        FROM content ct LEFT JOIN public.mos_content_v v ON v.id = ct.id
                       GROUP BY 1) s), '{}'::jsonb)),
    'placements', jsonb_build_object(
      'total', (SELECT count(*) FROM pubs),
      'by_platform', COALESCE((SELECT jsonb_object_agg(k, n) FROM (
                       SELECT platform AS k, count(*) AS n FROM pubs GROUP BY 1) s), '{}'::jsonb)),
    'ads', jsonb_build_object(
      'total',   (SELECT count(*) FROM ads),
      'running', (SELECT count(*) FROM ads WHERE status = 'running'),
      'paused',  (SELECT count(*) FROM ads WHERE status = 'paused'),
      'waiting', (SELECT count(*) FROM ads WHERE status = 'waiting')),
    'metrics', (SELECT jsonb_build_object(
        'spend',       COALESCE(sum(a.spend), 0),
        'impressions', COALESCE(sum(a.impressions), 0),
        'clicks',      COALESCE(sum(a.clicks), 0),
        'leads',       COALESCE(sum(a.leads), 0),
        'qualified',   COALESCE(sum(a.qualified), 0),
        'cpl', CASE WHEN COALESCE(sum(a.leads), 0) > 0
                    THEN COALESCE(sum(a.spend), 0) / sum(a.leads) END)
      FROM ads a),
    'executions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'platform', e.platform, 'label', e.label, 'status', e.status,
        'starts_on', e.starts_on, 'ends_on', e.ends_on, 'budget', e.budget,
        'ads', (SELECT count(*) FROM ads a WHERE a.execution_id = e.id),
        'slots_active', (SELECT count(*) FROM public.mos_creative_slots sl
                          WHERE sl.execution_id = e.id AND sl.status = 'active'))
        ORDER BY e.created_at) FROM ex e), '[]'::jsonb),
    'cycles', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', cy.id, 'execution_id', cy.execution_id, 'round', cy.round,
        'refresh_on', cy.refresh_on, 'status', cy.status) ORDER BY cy.round)
        FROM public.mos_refresh_cycles cy WHERE cy.execution_id IN (SELECT id FROM ex)), '[]'::jsonb),
    'batches', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', b.id, 'day', b.day, 'platform', b.platform, 'sequence', b.sequence,
        'items', b.items, 'risk', b.risk) ORDER BY b.day, b.sequence)
        FROM public.mos_publish_batch_v b WHERE b.campaign_id = p_campaign_id), '[]'::jsonb));
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 10. content_revise — the scope is DERIVED, the writer can only widen it
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.content_revise(p_content_id uuid, p_scope text[], p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_c      public.mos_content%ROWTYPE;
  v_last   public.mos_content_approvals%ROWTYPE;
  v_scope  text[] := ARRAY[]::text[];
  v_next   text;
  v_round  int;
  v_actor  uuid := public.wassell_app_user_id(auth.uid());
  v_wh     text;
  v_dh     text;
  v_ch     text;
  v_ver    uuid;
  v_new    uuid;
  v_step   jsonb;
BEGIN
  IF NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('revise_approved_content') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_c FROM public.mos_content WHERE id = p_content_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:CONTENT_NOT_FOUND %', p_content_id USING ERRCODE = 'no_data_found';
  END IF;

  v_wh := public.mos_content_writing_hash(p_content_id);
  v_dh := public.mos_content_design_hash(p_content_id);
  v_ch := public.mos_caption_hash(v_c.data ->> 'caption');

  SELECT * INTO v_last FROM public.mos_content_approvals
   WHERE content_id = p_content_id ORDER BY approved_at DESC LIMIT 1;

  -- DERIVE from what actually changed since the last approval.
  IF v_last.id IS NOT NULL THEN
    IF v_last.writing_hash IS DISTINCT FROM v_wh THEN v_scope := v_scope || 'writing'::text; END IF;
    IF v_last.design_hash  IS DISTINCT FROM v_dh THEN v_scope := v_scope || 'design'::text;  END IF;
    IF v_last.caption_hash IS DISTINCT FROM v_ch THEN v_scope := v_scope || 'caption'::text; END IF;
  END IF;
  -- ::text is load-bearing: a bare literal is UNKNOWN, so text[] || 'x' parses
  -- as array||array and dies with 22P02 malformed array literal.
  -- the caller may only WIDEN
  IF p_scope IS NOT NULL THEN
    SELECT array_agg(DISTINCT s) INTO v_scope
      FROM unnest(COALESCE(v_scope, ARRAY[]::text[]) || p_scope) s WHERE s IS NOT NULL;
  END IF;
  IF COALESCE(array_length(v_scope, 1), 0) = 0 THEN v_scope := ARRAY['caption']; END IF;

  -- A writing change that touches ANY design-affecting field widens to design.
  IF 'writing' = ANY (v_scope)
     AND EXISTS (SELECT 1 FROM public.mos_content_types ct
                  WHERE ct.id = v_c.content_type_id AND COALESCE(array_length(ct.design_fields,1),0) > 0)
     AND NOT ('design' = ANY (v_scope)) THEN
    v_scope := v_scope || 'design_affecting'::text;
  END IF;

  -- widest first step
  v_next := CASE
    WHEN 'writing' = ANY (v_scope) OR 'design_affecting' = ANY (v_scope) OR 'caption' = ANY (v_scope)
      THEN 'writing_review'
    WHEN 'design' = ANY (v_scope) THEN 'design_writer_review'
    ELSE 'writing_review' END;

  -- a caption-only revision invalidates the writer's confirmation (§9.3)
  IF 'caption' = ANY (v_scope) THEN
    UPDATE public.mos_content
       SET data = ((((data - 'caption_confirmed_text') - 'caption_confirmed_at')
                    - 'caption_confirmed_hash') - 'caption_confirmed_by_writer_at')
     WHERE id = p_content_id;
  END IF;

  v_round := COALESCE((SELECT max(round) FROM public.workflow_role_tasks
                        WHERE subject_table = 'mos_content' AND subject_id = p_content_id), 0) + 1;

  UPDATE public.mos_content
     SET data = data || jsonb_build_object('revision', jsonb_build_object(
                  'round', v_round, 'scope', to_jsonb(v_scope), 'note', p_note,
                  'opened_at', now(),
                  -- v1 records the steps a narrow scope SHOULD skip; the linear
                  -- path engine does not yet honour it (see the report).
                  'skip_steps', CASE WHEN v_scope = ARRAY['caption']
                                     THEN jsonb_build_array('design','design_writer_review')
                                     ELSE '[]'::jsonb END)),
         on_hold_at = NULL, rejected_at = NULL
   WHERE id = p_content_id;

  INSERT INTO public.mos_content_events (content_id, kind, actor_user_id, detail)
  VALUES (p_content_id, 'revision_opened', v_actor,
          jsonb_build_object('scope', to_jsonb(v_scope), 'note', p_note, 'round', v_round,
                             'writing_hash', v_wh, 'design_hash', v_dh, 'caption_hash', v_ch));

  -- open the first affected step, unless something is already open
  -- PERFORM the transition. Computing next_step and returning it while the
  -- item quietly stays on its old step is a lie the UI would faithfully
  -- repeat; a revision has to actually move the work.
  --
  -- Idempotent: if the target step is already open at this round, hand that
  -- task back rather than inserting a second one (uq_workflow_role_tasks_one_open
  -- would refuse it, but an exception is not how you discover that).
  SELECT t.id INTO v_new
    FROM public.workflow_role_tasks t
   WHERE t.subject_table = 'mos_content' AND t.subject_id = p_content_id
     AND t.status = 'open' AND t.step_key = v_next AND t.round = v_round
   LIMIT 1;

  IF v_new IS NULL THEN
    -- 1. close whatever is open -- this revision supersedes it, and closing it
    --    is what releases its ledger rows and keeps the round history honest.
    UPDATE public.workflow_role_tasks
       SET status = 'done', result = 'changes_requested', note = p_note,
           closed_at = now(), closed_by_user_id = v_actor
     WHERE subject_table = 'mos_content' AND subject_id = p_content_id AND status = 'open';

    -- 2. open the first affected step
    SELECT c.workflow_version_id INTO v_ver FROM public.mos_content c WHERE c.id = p_content_id;
    SELECT e.elem INTO v_step
      FROM public.workflow_versions v,
           LATERAL jsonb_array_elements(v.definition -> 'metadata' -> 'steps') e(elem)
     WHERE v.id = v_ver AND e.elem ->> 'key' = v_next LIMIT 1;
    IF v_step IS NOT NULL THEN
      INSERT INTO public.workflow_role_tasks
        (subject_table, subject_id, workflow_version_id, step_key, role_key, round, due_at)
      VALUES ('mos_content', p_content_id, v_ver, v_step ->> 'key', v_step ->> 'role_key', v_round,
              now() + COALESCE((v_step ->> 'due_days')::int, 2) * interval '1 day')
      RETURNING id INTO v_new;
      IF public.mos_plan_consume_reservation(v_new) IS NULL THEN
        PERFORM public.mos_perf_place_open_task(v_new);
      END IF;
    END IF;
  END IF;

  RETURN jsonb_build_object('scope', to_jsonb(v_scope), 'next_step', v_next,
                            'round', v_round, 'opened_task_id', v_new);
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 11. Refresh cycle: decide (writes the decision only) and apply
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_refresh_cycle_decide(
  p_cycle_id uuid, p_keep_ad_ids uuid[], p_replace_ad_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_cy    public.mos_refresh_cycles%ROWTYPE;
  v_actor uuid := public.wassell_app_user_id(auth.uid());
  v_bad   int;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('decide_refresh') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_cy FROM public.mos_refresh_cycles WHERE id = p_cycle_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:CYCLE_NOT_FOUND %', p_cycle_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_cy.status IN ('applied','cancelled','skipped') THEN
    RAISE EXCEPTION 'MOS:CYCLE_CLOSED %', v_cy.status USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT count(*) INTO v_bad
    FROM unnest(COALESCE(p_keep_ad_ids, '{}') || COALESCE(p_replace_ad_ids, '{}')) x(id)
   WHERE NOT EXISTS (SELECT 1 FROM public.mos_execution_ads a
                      WHERE a.id = x.id AND a.execution_id = v_cy.execution_id AND a.archived_at IS NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'MOS:AD_NOT_IN_EXECUTION' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(COALESCE(p_keep_ad_ids,'{}')) k
              JOIN unnest(COALESCE(p_replace_ad_ids,'{}')) r ON k = r) THEN
    RAISE EXCEPTION 'MOS:KEEP_REPLACE_OVERLAP' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.mos_refresh_cycles
     SET status   = 'decided',
         decision = COALESCE(decision, '{}'::jsonb) || jsonb_build_object(
           'keep', to_jsonb(COALESCE(p_keep_ad_ids, '{}')),
           'replace', to_jsonb(COALESCE(p_replace_ad_ids, '{}')),
           'decided_by', v_actor, 'decided_at', now()),
         updated_at = now()
   WHERE id = p_cycle_id;

  -- close the manager's decision task, if one is open
  UPDATE public.mos_manual_tasks
     SET status = 'done', closed_at = now(), closed_by_user_id = v_actor
   WHERE kind = 'refresh_decision' AND ref_id = p_cycle_id AND status = 'open';

  RETURN jsonb_build_object('cycle_id', p_cycle_id, 'status', 'decided',
                            'keep', COALESCE(array_length(p_keep_ad_ids, 1), 0),
                            'replace', COALESCE(array_length(p_replace_ad_ids, 1), 0));
END $$;

-- Apply — THE DATABASE HALF ONLY.
-- ----------------------------------------------------------------------------
-- It does NOT flip anything to active/retired. The worker
-- (worker/src/runRefreshCycleJob.ts) activates on Meta, polls effective_status
-- until ACTIVE (5-minute ceiling), and ONLY THEN pauses the outgoing ads —
-- that ordering is the whole point of §7.5 step 4, and SQL cannot verify Meta.
-- So this returns the two work lists and moves the cycle to 'applying'.
--
--   { activate:[{slot_id, ad_row_id, platform_ad_id,
--                shadow_ad_row_id, shadow_platform_ad_id}],
--     pause:   [ …same shape… ],   -- WORST-RANKED FIRST (§7.6, reversed)
--     min_active, cycle_status }
--
-- Idempotent: re-running on an 'applying' cycle returns the STILL-OUTSTANDING
-- work (ready-but-not-yet-active slots, running-but-not-yet-retired outgoing),
-- so a second call can never duplicate an activation.
--
-- The `pause` list is capped so the active count can never fall below
-- mos_settings.planning.min_active_creatives, and never exceeds the number of
-- replacements actually ready — a short slate keeps the BEST outgoing creatives
-- running because the list is worst-first and the worker trims from the end.
--
-- A banked spare is consumable ONLY through its earmarked cycle: this is the
-- enforcement point (`bank_reserved_for_cycle_id = p_cycle_id`).
--
-- The DB state is recorded afterwards by mos_refresh_cycle_record_swap().
CREATE OR REPLACE FUNCTION public.mos_refresh_cycle_apply(p_cycle_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_cy        public.mos_refresh_cycles%ROWTYPE;
  v_min       int;
  v_active    int;
  v_out       uuid[];
  v_expected  int;
  v_n_act     int;
  v_cap       int;
  v_from      date;
  v_to        date;
  v_activate  jsonb;
  v_pause     jsonb;
BEGIN
  PERFORM public.mos_ledger_lock();

  SELECT * INTO v_cy FROM public.mos_refresh_cycles WHERE id = p_cycle_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:CYCLE_NOT_FOUND %', p_cycle_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_cy.status = 'applied' THEN
    RETURN jsonb_build_object('cycle_id', p_cycle_id, 'cycle_status', 'applied', 'already', true,
                              'activate', '[]'::jsonb, 'pause', '[]'::jsonb,
                              'min_active', COALESCE((SELECT (value ->> 'min_active_creatives')::int
                                                        FROM public.mos_settings WHERE key = 'planning'), 5));
  END IF;
  IF v_cy.status NOT IN ('decided','applying','partial','ready','producing') THEN
    RAISE EXCEPTION 'MOS:CYCLE_NOT_DECIDED %', v_cy.status USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_min := COALESCE((SELECT (value ->> 'min_active_creatives')::int
                       FROM public.mos_settings WHERE key = 'planning'), 5);

  SELECT array_agg(x::uuid) INTO v_out
    FROM jsonb_array_elements_text(COALESCE(v_cy.decision -> 'replace', '[]'::jsonb)) x;
  v_out := COALESCE(v_out, '{}'::uuid[]);
  v_expected := COALESCE(array_length(v_out, 1), 0);

  -- ── the replacements that are genuinely ready (ad built, PAUSED) ─────────
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slot_id', t.slot_id, 'ad_row_id', t.ad_row_id,
           'platform_ad_id', t.platform_ad_id,
           'shadow_ad_row_id', t.shadow_ad_row_id,
           'shadow_platform_ad_id', t.shadow_platform_ad_id) ORDER BY t.slot_index), '[]'::jsonb),
         count(*)
    INTO v_activate, v_n_act
    FROM (
      SELECT sl.id AS slot_id, sl.slot_index, a.id AS ad_row_id, a.platform_ad_id,
             sh.id AS shadow_ad_row_id, sh.platform_ad_id AS shadow_platform_ad_id
        FROM public.mos_creative_slots sl
        JOIN public.mos_execution_ads a ON a.id = sl.ad_row_id AND a.archived_at IS NULL
        LEFT JOIN public.mos_execution_ads sh
               ON sh.pair_id = a.id AND sh.placement_variant = 'story' AND sh.archived_at IS NULL
       WHERE sl.status = 'ready'
         AND sl.ad_row_id IS NOT NULL
         AND (sl.cycle_id = p_cycle_id OR sl.bank_reserved_for_cycle_id = p_cycle_id)
    ) t;

  -- ── how many outgoing ads we may pause ──────────────────────────────────
  SELECT count(*) INTO v_active
    FROM public.mos_execution_ads a
   WHERE a.execution_id = v_cy.execution_id AND a.archived_at IS NULL
     AND a.status = 'running' AND a.retired_at IS NULL;

  -- never more than we can replace, and never below the guard once the
  -- replacements are live (active + activated - paused >= min_active)
  v_cap := GREATEST(LEAST(v_n_act, v_active + v_n_act - v_min), 0);

  v_from := COALESCE((SELECT max(prev.refresh_on) FROM public.mos_refresh_cycles prev
                       WHERE prev.execution_id = v_cy.execution_id AND prev.round < v_cy.round),
                     v_cy.production_start_on, public.mos_perf_today() - 7);
  v_to   := COALESCE(v_cy.decision_due_on, public.mos_perf_today());

  -- WORST-RANKED FIRST — the reverse of §7.6. A creative with NO leads ranks
  -- below every creative that has leads (CTR asc, then CPM desc among them);
  -- among those with leads the WORST is the highest CPL. CPL = spend ÷ leads,
  -- and zero leads leaves it undefined, never zero.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slot_id', t.slot_id, 'ad_row_id', t.ad_row_id,
           'platform_ad_id', t.platform_ad_id,
           'shadow_ad_row_id', t.shadow_ad_row_id,
           'shadow_platform_ad_id', t.shadow_platform_ad_id) ORDER BY t.rn), '[]'::jsonb)
    INTO v_pause
    FROM (
      SELECT sl.id AS slot_id, a.id AS ad_row_id, a.platform_ad_id,
             sh.id AS shadow_ad_row_id, sh.platform_ad_id AS shadow_platform_ad_id,
             row_number() OVER (
               ORDER BY (COALESCE((m ->> 'leads')::numeric, 0) > 0) ASC,
                        CASE WHEN COALESCE((m ->> 'leads')::numeric, 0) = 0
                             THEN (m ->> 'ctr')::numeric END ASC NULLS FIRST,
                        CASE WHEN COALESCE((m ->> 'leads')::numeric, 0) = 0
                             THEN (m ->> 'cpm')::numeric END DESC NULLS LAST,
                        CASE WHEN COALESCE((m ->> 'leads')::numeric, 0) > 0
                             THEN (m ->> 'cpl')::numeric END DESC NULLS LAST,
                        a.created_at) AS rn
        FROM public.mos_execution_ads a
        LEFT JOIN public.mos_creative_slots sl ON sl.ad_row_id = a.id AND sl.status = 'active'
        LEFT JOIN public.mos_execution_ads sh
               ON sh.pair_id = a.id AND sh.placement_variant = 'story' AND sh.archived_at IS NULL
        CROSS JOIN LATERAL (SELECT public.mos_creative_window_metrics(a.id, v_from, v_to) AS m) mm
       WHERE a.id = ANY (v_out)
         AND a.archived_at IS NULL AND a.retired_at IS NULL AND a.status = 'running'
    ) t
   WHERE t.rn <= v_cap;

  UPDATE public.mos_refresh_cycles SET status = 'applying', updated_at = now()
   WHERE id = p_cycle_id AND status <> 'applying';

  -- A slate short of its decision is a KNOWN fact right now — page the manager
  -- (§7.5 step 5) without waiting for the Meta half.
  IF v_expected > v_n_act THEN
    INSERT INTO public.mos_manual_tasks
      (title, details, assignee_user_id, created_by_user_id, kind, ref_id, entity_kind, entity_id,
       action, due_at, campaign_id)
    SELECT 'تأخر ' || (v_expected - v_n_act) || ' من بدائل التحديث',
           'الدورة ' || v_cy.round || ' — جاهز: ' || v_n_act || ' من ' || v_expected,
           u.id, u.id, 'plan_conflict', p_cycle_id, 'refresh_cycle', p_cycle_id,
           'review_refresh_cycle', now() + interval '1 day', ex.campaign_id
      FROM public.mos_campaign_executions ex
      CROSS JOIN LATERAL (
        SELECT us.id FROM public.users us
         WHERE us.is_active
           AND EXISTS (SELECT 1 FROM public.roles rr
                        WHERE rr.key = 'mos_marketing_manager'
                          AND rr.id::text IN (SELECT el ->> 'role_id'
                                                FROM jsonb_array_elements(COALESCE(us.role_assignments,'[]'::jsonb)) el))
         ORDER BY us.created_at LIMIT 1) u
     WHERE ex.id = v_cy.execution_id
       AND NOT EXISTS (SELECT 1 FROM public.mos_manual_tasks mt
                        WHERE mt.kind = 'plan_conflict' AND mt.ref_id = p_cycle_id AND mt.status = 'open');
  END IF;

  RETURN jsonb_build_object(
    'cycle_id', p_cycle_id, 'cycle_status', 'applying', 'already', false,
    'activate', v_activate, 'pause', v_pause,
    'min_active', v_min, 'active_before', v_active,
    'ready', v_n_act, 'expected', v_expected,
    'window', jsonb_build_object('from', v_from, 'to', v_to));
END $$;

-- The completion half. The worker calls it AFTER Meta confirmed each side, so
-- the database only ever records what actually happened. Idempotent per ad.
CREATE OR REPLACE FUNCTION public.mos_refresh_cycle_record_swap(
  p_cycle_id uuid, p_activated_ad_ids uuid[], p_paused_ad_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_cy        public.mos_refresh_cycles%ROWTYPE;
  v_act       uuid[] := COALESCE(p_activated_ad_ids, '{}'::uuid[]);
  v_pau       uuid[] := COALESCE(p_paused_ad_ids, '{}'::uuid[]);
  v_min       int;
  v_active    int;
  v_expected  int;
  v_done      int;
  v_n_act     int := 0;
  v_n_pau     int := 0;
BEGIN
  PERFORM public.mos_ledger_lock();

  SELECT * INTO v_cy FROM public.mos_refresh_cycles WHERE id = p_cycle_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:CYCLE_NOT_FOUND %', p_cycle_id USING ERRCODE = 'no_data_found';
  END IF;

  v_min := COALESCE((SELECT (value ->> 'min_active_creatives')::int
                       FROM public.mos_settings WHERE key = 'planning'), 5);

  UPDATE public.mos_execution_ads
     SET status = 'running', activated_at = COALESCE(activated_at, now())
   WHERE id = ANY (v_act) AND archived_at IS NULL AND retired_at IS NULL;
  GET DIAGNOSTICS v_n_act = ROW_COUNT;

  UPDATE public.mos_creative_slots
     SET status = 'active', activated_at = COALESCE(activated_at, now()),
         cycle_id = COALESCE(cycle_id, p_cycle_id), bank_reserved_for_cycle_id = NULL
   WHERE ad_row_id = ANY (v_act) AND status = 'ready';

  -- The guard applies HERE too: never record a pause that would take the
  -- execution below the minimum active count.
  SELECT count(*) INTO v_active
    FROM public.mos_execution_ads a
   WHERE a.execution_id = v_cy.execution_id AND a.archived_at IS NULL
     AND a.status = 'running' AND a.retired_at IS NULL;

  IF (v_active - COALESCE(array_length(v_pau, 1), 0)) < v_min THEN
    RAISE EXCEPTION 'MOS:MIN_ACTIVE_GUARD active=% pausing=% min=%',
      v_active, COALESCE(array_length(v_pau, 1), 0), v_min
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.mos_execution_ads
     SET status = 'paused', retired_at = COALESCE(retired_at, now())
   WHERE id = ANY (v_pau) AND archived_at IS NULL AND retired_at IS NULL;
  GET DIAGNOSTICS v_n_pau = ROW_COUNT;

  UPDATE public.mos_creative_slots
     SET status = 'retired', retired_at = COALESCE(retired_at, now())
   WHERE ad_row_id = ANY (v_pau) AND status = 'active';

  SELECT COALESCE(jsonb_array_length(v_cy.decision -> 'replace'), 0) INTO v_expected;
  SELECT count(*) INTO v_done
    FROM public.mos_creative_slots sl
   WHERE sl.cycle_id = p_cycle_id AND sl.status = 'active';

  UPDATE public.mos_refresh_cycles
     SET status = CASE WHEN v_done >= v_expected AND v_expected > 0 THEN 'applied' ELSE 'partial' END,
         updated_at = now()
   WHERE id = p_cycle_id;

  RETURN jsonb_build_object('cycle_id', p_cycle_id, 'activated', v_n_act, 'paused', v_n_pau,
    'cycle_status', (SELECT status FROM public.mos_refresh_cycles WHERE id = p_cycle_id),
    'active_after', (SELECT count(*) FROM public.mos_execution_ads a
                      WHERE a.execution_id = v_cy.execution_id AND a.archived_at IS NULL
                        AND a.status = 'running' AND a.retired_at IS NULL));
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 12. Grants — Supabase grants EXECUTE to anon by default; revoke, then grant.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('mos_ledger_lock','mos_tg_ledger_lock','mos_workload_snapshot_hash',
                         'mos_plan_consume_reservation','mos_plan_release','mos_plan_release_internal',
                         'mos_tg_release_reservations',
                         'mos_campaign_plan_commit','mos_plan_start_due','mos_plan_repair',
                         'mos_content_writing_hash','mos_content_design_hash','mos_content_package_hash',
                         'content_ad_readiness','mos_campaign_rollup','content_revise',
                         'mos_refresh_cycle_decide','mos_refresh_cycle_apply',
                         'mos_refresh_cycle_record_swap')
  LOOP
    -- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon AND
    -- authenticated the moment the function is created, so revoking PUBLIC +
    -- anon is NOT enough — `authenticated` has to be revoked explicitly and
    -- granted back only where it belongs.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    -- Sweep + lock helpers are server-side only. Everything else the SPA/API
    -- may call with the caller's JWT — each does its own capability check.
    IF r.proname IN ('mos_plan_start_due','mos_ledger_lock','mos_tg_ledger_lock',
                     'mos_plan_release_internal','mos_tg_release_reservations') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
    END IF;
  END LOOP;
END $$;
