-- ============================================================================
-- B4 follow-up — the deferred paid reservation gets its rope home. 2026-09-15.
--
-- The adversarial audit of 2026-09-15_22 passed eight of nine structural
-- checks and found one real defect plus two small ones. This file fixes all
-- three. It changes NOTHING else: the body below is 2026-09-15_22's body with
-- five hunks replaced, and the migration was generated from that file rather
-- than retyped.
--
-- ── 1. THE ONE THAT MATTERS ────────────────────────────────────────────────
--
-- 2026-09-15_22 relaxed `num_nonnulls(content_id, row_id) = 1` to `<= 1` and
-- justified it with: "the paid lane deliberately creates UNBOUND reservations
-- … and `mos_plan_start_due` then binds them with `WHERE content_id IS NULL
-- AND row_id IS NULL AND cycle_id = …`."
--
-- THAT BIND COULD NEVER FIRE. Nothing populated `cycle_id`:
--
--   * `reservationsPayload` (api/_lib/marketing/planning/actions.ts) emitted
--     item_key, row_key, step_key, role_key, bucket, assignee_user_id,
--     planned_start, planned_end, weight, spread, weights — no cycle.
--     `PlannedReservation` had no field to emit.
--   * `mos_campaign_plan_commit` is the ONLY function in `public` that writes
--     the column, and it read it from `e ->> 'cycle_id'`, so it always wrote
--     NULL.
--   * `cycle_id = r.cycle_id` with cycle_id NULL is NULL, never true.
--     Measured on production: res_cycle_id_NOT_NULL = 0,
--     sweep_bind_would_match = 0.
--   * `mos_plan_consume_reservation`'s content_key fallback could not rescue
--     them either: it reads the key off `mos_content_plan`, and
--     `mos_plan_start_due` creates its lazy shell with a bare INSERT INTO
--     mos_content and no plan row, so the key is NULL.
--
-- The consequence is a silent, permanent capacity leak. `mos_work_ledger_v`'s
-- two reservation arms filter on status and assignee only — they do NOT
-- require a subject — so every orphan charges its assignee's capacity
-- indefinitely, and `mos_plan_repair` marks it stale and re-dates it onto
-- today's working days forever (a campaign-scoped repair skips it entirely:
-- its filter joins on cp.content_id = res.content_id, which is NULL). At 75 of
-- every paid plan's 100 reservations and three paid plans a month, that is
-- ~225 reservations a month booking time nothing ever consumes. Nothing
-- errors. Nothing turns red. This repo has a written rule about exactly that
-- shape of bug (CLAUDE.md, "Silent Failures").
--
-- THE LOOP IS CLOSED HERE, NOT WORKED AROUND. The planner now states the
-- cycle its reservation belongs to. It states it as the COMPOSITE KEY
-- `execution_key#round` and not a uuid, because `mos_refresh_cycles` rows do
-- not exist at plan time — this very function creates them, a few loops above
-- the reservation loop. So the key is resolved HERE, against the `v_cycle_map`
-- the cycles loop already builds with the identical key, and the real uuid is
-- written to `mos_task_reservations.cycle_id`. `mos_plan_start_due`'s existing
-- predicate is untouched and simply starts matching; its second clause
-- (`content_key = slot.content_key`) already matched, because the reservation
-- carries the item key and the slot carries the same string.
--
-- AND WHAT STILL CANNOT BE BOUND IS NOW REFUSED BY NAME. A reservation with no
-- content, no row and no cycle is a shape nothing in the system can ever bind,
-- consume, release or repair. It is now `MOS:UNBINDABLE_RESERVATION <key>`
-- instead of a row that quietly books a designer's month. Same posture as
-- MOS:UNKNOWN_ROW_KEY: the loudness lives in the RPC, where it can name the
-- offending key.
--
-- ── 2. A NULL item_key SLIPPED PAST THE GUARD ──────────────────────────────
--
-- `NOT (v_item_map ? (e ->> 'item_key'))` with a JSON null item_key is
-- `NOT NULL` = NULL, and an IF on NULL does not fire. Proved live: the
-- reservation was accepted and landed with every binding column NULL.
-- `COALESCE(e ->> 'item_key', '')` closes it — '' is in no map.
--
-- ── 3. v_n_pub / v_n_slot OVER-REPORTED ────────────────────────────────────
--
-- Both incremented unconditionally after `ON CONFLICT … DO NOTHING`, so a
-- retried commit reported publications and slots it did not write (the slot
-- INSERT is also gated on a resolvable execution key). The release arm already
-- guarded on `IF FOUND`; these two now match it.
--
-- ── WHAT THIS FILE DOES NOT CHANGE ─────────────────────────────────────────
--
--   * The `<= 1` constraint stays. The audit re-proved it is a required fix:
--     re-adding `= 1` aborts a real 4-round paid month with 23514.
--   * `mos_plan_start_due`, `mos_plan_consume_reservation`, `mos_plan_repair`
--     and `mos_work_ledger_v` are untouched — the bind predicate was always
--     right, it was starved of data.
--   * `mos_campaign_plan_commit_month`, the advisory ledger lock, the hash
--     gate, the capacity re-check, the rows/pairs/variant work of B4: byte for
--     byte as 2026-09-15_22 left them.
--   * The WS409 contract. NOTHING here raises SQLSTATE 40001 / 40P01 —
--     PostgREST retries those forever and that is this repo's documented
--     conflict-storm root cause (CLAUDE.md).
--
-- No backfill: `mos_task_reservations` held 0 rows on production when this was
-- written, so there is no historical orphan to repair.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

BEGIN;

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
  -- ── B4 ────────────────────────────────────────────────────────────────
  v_row_map   jsonb := '{}'::jsonb;   -- rows[].row_key            -> mos_content_rows.id
  v_pair_map  jsonb := '{}'::jsonb;   -- releases[].pair_id (text) -> mos_publications.id
  v_pl        jsonb;                  -- the placement a release reads batch/grid from
  v_row_id    uuid;
  v_cycle_id  uuid;                   -- the reservation's refresh cycle, RESOLVED
  v_res_cid   uuid;                   -- the reservation's content subject, or NULL
  v_pub_id    uuid;
  v_pair_uuid uuid;
  v_pair_key  text;
  v_variant   text;
  v_n_rows    int := 0;
  v_n_rel     int := 0;
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

  -- (c) INDEPENDENT SQL capacity re-check. Does not trust the TS arithmetic.
  -- `weight` is the reservation's TOTAL effort, so it must be spread by the
  -- SAME mos_spread_effort() the ledger view uses — one slot per working day,
  -- [1, 1, …, remainder]. Emitting the scalar once per day of the window
  -- double-counted every multi-day step (3 two-day designs scored 6 on one day
  -- instead of 3) and produced a bogus WS409 capacity_conflict.
  -- B4: the spread MODE is now read off the payload instead of assumed.
  -- `mos_spread_effort` lays N over N working days, which reads a ROW's
  -- "three slots on Monday" as "one slot on Mon, Tue and Wed" — a spurious
  -- WS409 on two days the planner never touched and a missed overbook on the
  -- one it did. `mos_work_ledger_v` already charges a row reservation same-day
  -- (C3, keyed on row_id); this makes the proposal side agree, keyed on the
  -- `spread` the planner STATES. The two must not drift: a divergence between
  -- the JS preview and this SQL re-check has already produced a bogus WS409.
  WITH prop AS (
    SELECT (x ->> 'assignee_user_id')::uuid       AS uid,
           COALESCE(x ->> 'bucket', 'post')       AS bucket,
           (x ->> 'planned_start')::date          AS ps,
           COALESCE((x ->> 'weight')::numeric, 1) AS total,
           COALESCE(NULLIF(x ->> 'spread', ''), 'per_day') AS spread
      FROM jsonb_array_elements(COALESCE(p_reservations, '[]'::jsonb)) x
     WHERE NULLIF(x ->> 'assignee_user_id', '') IS NOT NULL
  ), spread AS (
    SELECT prop.uid, prop.bucket, s.day, s.weight AS w
      FROM prop
      CROSS JOIN LATERAL public.mos_spread_effort_mode(
            GREATEST(prop.ps, public.mos_perf_today()), prop.total,
            prop.spread = 'same_day') s
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

  -- rule 1b (B4): one mos_content_rows per rows[] entry, BEFORE the items that
  -- point at it. A row is a real workflow subject: it carries the open task,
  -- the reservation and its OWN pinned workflow version, because
  -- workflow_advance_role_path reads the step definition off the SUBJECT and a
  -- row has no mos_content to read it from.
  --
  -- project_id is NULLABLE on purpose (A8b) — the Saturday general row belongs
  -- to no project and is a quarter of the organic month.
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_materialise -> 'rows', '[]'::jsonb)) LOOP
    CONTINUE WHEN NULLIF(e ->> 'row_key', '') IS NULL;

    -- The row pins the SAME version its members pin: the latest of the
    -- members' workflow (A11 shipped post_std v8 / video_std v7, and
    -- `version_no DESC LIMIT 1` is exactly how the items below choose too, so
    -- the row and its three posts can never end up on different rulebooks).
    -- The 24 pre-cutover records keep whatever is already stamped on them —
    -- nothing here rewrites an existing mos_content.workflow_version_id.
    v_ver := NULL;
    SELECT (SELECT wv.id FROM public.workflow_versions wv
             WHERE wv.workflow_id = ct.workflow_id
             ORDER BY wv.version_no DESC LIMIT 1)
      INTO v_ver
      FROM public.mos_content_types ct
     WHERE ct.archived_at IS NULL
       AND ct.key = (SELECT it2.value ->> 'content_type_key'
                       FROM jsonb_array_elements(COALESCE(p_materialise -> 'items', '[]'::jsonb)) it2
                      WHERE it2.value ->> 'row_key' = e ->> 'row_key'
                      ORDER BY COALESCE((it2.value ->> 'row_order')::int, 0)
                      LIMIT 1);

    SELECT id INTO v_id FROM public.mos_content_rows WHERE row_key = e ->> 'row_key';
    IF v_id IS NULL THEN
      INSERT INTO public.mos_content_rows
        (campaign_id, project_id, plan_id, kind, batch_day, workflow_version_id, row_key)
      VALUES (v_campaign,
              NULLIF(e ->> 'project_id', '')::uuid,
              p_plan_id,
              COALESCE(NULLIF(e ->> 'kind', ''), 'organic_row'),
              NULLIF(e ->> 'batch_day', '')::date,
              v_ver,
              e ->> 'row_key')
      RETURNING id INTO v_id;
      v_n_rows := v_n_rows + 1;
    ELSE
      -- Re-commit of the same month: the row is keyed by row_key (UNIQUE), so
      -- it is reused rather than duplicated, and re-pointed at this plan.
      UPDATE public.mos_content_rows
         SET campaign_id         = COALESCE(v_campaign, campaign_id),
             plan_id             = p_plan_id,
             project_id          = NULLIF(e ->> 'project_id', '')::uuid,
             kind                = COALESCE(NULLIF(e ->> 'kind', ''), kind),
             batch_day           = COALESCE(NULLIF(e ->> 'batch_day', '')::date, batch_day),
             workflow_version_id = COALESCE(v_ver, workflow_version_id),
             updated_at          = now()
       WHERE id = v_id;
    END IF;
    v_row_map := v_row_map || jsonb_build_object(e ->> 'row_key', v_id::text);
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
           campaign_id, purpose, target_publish_at, created_by_user_id, organic_platforms,
           row_id, row_order)
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
                                  '{}'::text[]) END,
               -- B4: the member joins its row. row_order is the WRITER's order;
               -- publish order is its reverse and lives in the placement time.
               NULLIF(v_row_map ->> COALESCE(it ->> 'row_key', ''), '')::uuid,
               NULLIF(it ->> 'row_order', '')::int
          FROM public.mos_content_types ct WHERE ct.id = v_ct
        RETURNING id INTO v_id;
        v_n_items := v_n_items + 1;
      END IF;
    END IF;

    IF v_id IS NOT NULL THEN
      -- B4: a member materialised by an EARLIER attempt (before its row
      -- existed, or before this code shipped) is re-linked here. Without this
      -- a retried commit leaves orphan members whose open task sits on a row
      -- they do not point at, and mos_content_v resolves them as 'done'.
      IF NULLIF(it ->> 'row_key', '') IS NOT NULL THEN
        UPDATE public.mos_content
           SET row_id    = NULLIF(v_row_map ->> (it ->> 'row_key'), '')::uuid,
               row_order = NULLIF(it ->> 'row_order', '')::int,
               updated_at = now()
         WHERE id = v_id
           AND (row_id    IS DISTINCT FROM NULLIF(v_row_map ->> (it ->> 'row_key'), '')::uuid
             OR row_order IS DISTINCT FROM NULLIF(it ->> 'row_order', '')::int);
      END IF;

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
        -- B4: ONE PUBLICATION PER RELEASE, NOT PER PLACEMENT.
        --
        -- Every organic post in a row publishes TWICE — the square design as a
        -- FEED post carrying the caption, and the vertical design as a STORY
        -- carrying none (§3.4 rule 4). The engine has emitted that pair since
        -- B3; this loop consumes the STATED `releases[]` key instead of
        -- re-deriving a pair from `placements[]`, so the split, the pair and
        -- the moment all come from one producer.
        --
        -- The moment is READ, never recomputed: `planned_at` already encodes
        -- the reversal (the first-read post publishes LAST), and recomputing it
        -- here is exactly how mos_content_placements and mos_publications came
        -- to hold different times for the same post.
        --
        -- `carries_caption` gets no column: `placement_variant = 'story'` IS
        -- the discriminator, and the publish path derives it from there.
        SELECT count(*) INTO v_n_rel
          FROM jsonb_array_elements(COALESCE(p_materialise -> 'releases', '[]'::jsonb)) x
         WHERE x.value ->> 'item_key' = it ->> 'key'
           AND COALESCE(x.value ->> 'kind', 'organic') <> 'ad';

        IF v_n_rel = 0 THEN
          -- Legacy payload with no releases[] (an older client, or a path that
          -- never built them). Unchanged behaviour: one publication per
          -- placement, no variant, no pair.
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
            ON CONFLICT (content_id, platform, account_id, COALESCE(placement_variant, '')) DO NOTHING;
            -- Count what was WRITTEN, not what was attempted. DO NOTHING
            -- swallows the row on a retried commit, and incrementing anyway
            -- reported publications this call did not create. The release arm
            -- below has always guarded on FOUND; this one now matches it.
            IF FOUND THEN v_n_pub := v_n_pub + 1; END IF;
          END LOOP;
        ELSE
          -- FEED FIRST, deliberately: the feed release's pair key is its OWN
          -- key (the mos_ad_sets convention), so the feed anchors the pair and
          -- the story adopts the id of a row that already exists.
          FOR pl IN
            SELECT x.value
              FROM jsonb_array_elements(COALESCE(p_materialise -> 'releases', '[]'::jsonb)) x
             WHERE x.value ->> 'item_key' = it ->> 'key'
               AND COALESCE(x.value ->> 'kind', 'organic') <> 'ad'
             ORDER BY ((x.value ->> 'placement_variant') IS NOT DISTINCT FROM 'story'),
                      x.value ->> 'key'
          LOOP
            v_variant  := NULLIF(pl ->> 'placement_variant', '');
            v_pair_key := NULLIF(pl ->> 'pair_id', '');
            v_pub_id   := NULL;

            SELECT pb.id INTO v_pub_id
              FROM public.mos_publications pb
             WHERE pb.content_id = v_id
               AND pb.platform = pl ->> 'platform'
               AND COALESCE(pb.placement_variant, '') = COALESCE(v_variant, '');

            IF v_pub_id IS NOT NULL THEN
              -- Already there (a retried commit). Adopt ITS pair id so the
              -- other half links to a row that exists, and stamp the pair on a
              -- publication written before these two columns did.
              SELECT COALESCE(pb.pair_id, pb.id) INTO v_pair_uuid
                FROM public.mos_publications pb WHERE pb.id = v_pub_id;
              IF v_pair_key IS NOT NULL THEN
                v_pair_map := v_pair_map || jsonb_build_object(v_pair_key, v_pair_uuid::text);
                UPDATE public.mos_publications
                   SET pair_id           = COALESCE(pair_id, v_pair_uuid),
                       placement_variant = COALESCE(placement_variant, v_variant),
                       updated_at        = now()
                 WHERE id = v_pub_id
                   AND (pair_id IS NULL OR placement_variant IS NULL);
              END IF;
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

              -- batch_id / grid_row / grid_col are PLACEMENT facts; a release
              -- carries the moment, not the grid. Taken from the placement
              -- this release belongs to rather than invented.
              v_pl := NULL;
              SELECT p2.value INTO v_pl
                FROM jsonb_array_elements(COALESCE(it -> 'placements', '[]'::jsonb)) p2
               WHERE p2.value ->> 'platform' = pl ->> 'platform'
                 AND (p2.value ->> 'day') IS NOT DISTINCT FROM (pl ->> 'day')
               LIMIT 1;
              v_pl := COALESCE(v_pl, '{}'::jsonb);

              INSERT INTO public.mos_publications
                (id, content_id, platform, account_id, status, planned_at,
                 execution_id, batch_id, grid_row, grid_col, campaign_id,
                 scheduled_timezone, placement_variant, pair_id)
              VALUES (v_pub_id, v_id, pl ->> 'platform',
                      -- S3: the plan's account if it has one; the BEFORE INSERT
                      -- trigger resolves the connected publishable account when
                      -- it does not, and leaves NULL when none can publish.
                      NULLIF(pl ->> 'account_id', '')::uuid,
                      'planned',
                      NULLIF(pl ->> 'planned_at', '')::timestamptz,
                      NULLIF(v_exec_map ->> (pl ->> 'execution_key'), '')::uuid,
                      NULLIF(v_batch_map ->> (v_pl ->> 'batch_key'), '')::uuid,
                      NULLIF(v_pl ->> 'grid_row', '')::int,
                      NULLIF(v_pl ->> 'grid_col', '')::int,
                      v_campaign, 'Asia/Riyadh', v_variant, v_pair_uuid)
              ON CONFLICT (content_id, platform, account_id, COALESCE(placement_variant, '')) DO NOTHING;

              IF FOUND THEN
                v_n_pub := v_n_pub + 1;
              ELSE
                -- Lost the race (or the same destination twice in one payload).
                -- Re-read the winner so the pair map never points at an id we
                -- invented and then discarded.
                SELECT pb.id, COALESCE(pb.pair_id, pb.id) INTO v_pub_id, v_pair_uuid
                  FROM public.mos_publications pb
                 WHERE pb.content_id = v_id
                   AND pb.platform = pl ->> 'platform'
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
      -- Same as v_n_pub. This INSERT ... SELECT is also gated on a resolvable
      -- execution key, so an unresolvable one wrote nothing and still counted.
      IF FOUND THEN v_n_slot := v_n_slot + 1; END IF;
    END IF;
  END LOOP;

  -- rule 4: reservations
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_reservations, '[]'::jsonb)) LOOP
    -- B4: a reservation names EXACTLY ONE subject — a content item or a ROW.
    -- `item_key` is the subject's key either way; `row_key` says which.
    -- mos_plan_start_due opens a row's task off `row_id` (not row_key), so a
    -- row reservation that failed to resolve would leave the row with a
    -- reservation nothing can find: no task, no assignee, no window, silently.
    -- It therefore refuses by name instead.
    v_row_id := NULLIF(v_row_map ->> COALESCE(e ->> 'row_key', ''), '')::uuid;
    IF NULLIF(e ->> 'row_key', '') IS NOT NULL AND v_row_id IS NULL THEN
      RAISE EXCEPTION 'MOS:UNKNOWN_ROW_KEY %', e ->> 'row_key'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- A reservation with no row must name an item the payload KNOWS. An item
    -- key present in the map but empty is the deliberate deferred paid shell
    -- (a later refresh round, created lazily by the sweep) and stays unbound;
    -- a key that is absent altogether is a dangling reference and is refused.
    --
    -- COALESCE, NOT THE BARE ARROW. `v_item_map ? NULL` is NULL, `NOT NULL` is
    -- NULL, and an IF on NULL does not fire — so a JSON null item_key walked
    -- straight past this guard and landed as a reservation with content_id,
    -- row_id, content_key AND cycle_id all NULL: unreachable by every binder,
    -- and charging its assignee's capacity forever. '' is in no map, so the
    -- null is now refused by name like any other dangling key.
    IF NULLIF(e ->> 'row_key', '') IS NULL
       AND NOT (v_item_map ? COALESCE(e ->> 'item_key', '')) THEN
      RAISE EXCEPTION 'MOS:UNKNOWN_ITEM_KEY %', COALESCE(e ->> 'item_key', '(null)')
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- THE DEFERRED PAID SHELL'S ONLY ROPE HOME.
    --
    -- A paid item whose creative slot belongs to a LATER refresh round gets no
    -- content shell here (the sweep creates it lazily at
    -- production_start_on), so its reservation lands subject-less by design —
    -- which is the whole reason mos_task_reservations_one_subject is "<= 1".
    -- `mos_plan_start_due` then binds it with
    --
    --     WHERE content_id IS NULL AND row_id IS NULL
    --       AND cycle_id = <the cycle it is creating shells for>
    --       AND content_key IS NOT NULL AND content_key = <slot.content_key>
    --
    -- and until this migration NOTHING EVER FILLED cycle_id. The planner does
    -- not emit a cycle uuid because mos_refresh_cycles rows do not exist until
    -- THIS transaction creates them a few loops above; `cycle_id = NULL` is
    -- NULL, never true; so the bind matched zero rows, every deferred
    -- reservation stayed orphaned, mos_work_ledger_v (whose reservation arms
    -- do not require a subject) kept charging its assignee's capacity, and
    -- mos_plan_repair re-dated it onto today forever. Measured on production
    -- 2026-09-15: res_cycle_id_NOT_NULL = 0, sweep_bind_would_match = 0, at 75
    -- of every paid plan's 100 reservations.
    --
    -- So the planner now states the cycle by the SAME composite key
    -- `v_cycle_map` is built with — `execution_key#round` — and it is resolved
    -- HERE, where the uuid finally exists. A literal `cycle_id` is still
    -- honoured first for a caller that has one.
    v_cycle_id := COALESCE(
      NULLIF(e ->> 'cycle_id', '')::uuid,
      NULLIF(v_cycle_map ->> COALESCE(e ->> 'cycle_key', ''), '')::uuid);
    v_res_cid  := CASE WHEN v_row_id IS NULL
                       THEN NULLIF(v_item_map ->> (e ->> 'item_key'), '')::uuid END;

    -- NO SUBJECT AND NO CYCLE IS NOT A SHAPE ANYTHING CAN BIND.
    -- `mos_plan_start_due` needs the cycle, `mos_plan_consume_reservation`
    -- needs a subject or a content_key that resolves through
    -- mos_content_plan (a lazily created shell has no such row), and
    -- `mos_plan_repair`'s campaign filter joins on content_id. A row in this
    -- shape books capacity that nothing can ever consume or release, and the
    -- ledger reports it as real work. Refuse it BY NAME instead — the same
    -- posture as MOS:UNKNOWN_ROW_KEY above.
    IF v_res_cid IS NULL AND v_row_id IS NULL AND v_cycle_id IS NULL THEN
      RAISE EXCEPTION 'MOS:UNBINDABLE_RESERVATION %', COALESCE(e ->> 'item_key', '(null)')
        USING ERRCODE = 'invalid_parameter_value',
              HINT = 'a deferred paid reservation must carry cycle_key (execution_key#round) or cycle_id';
    END IF;

    INSERT INTO public.mos_task_reservations
      (plan_id, content_id, row_id, content_key, step_key, role_key, assignee_user_id, bucket,
       planned_start, planned_end, weight, status,
       cycle_id)
    VALUES (p_plan_id,
            v_res_cid,
            v_row_id,
            e ->> 'item_key',
            e ->> 'step_key', e ->> 'role_key',
            NULLIF(e ->> 'assignee_user_id', '')::uuid,
            COALESCE(e ->> 'bucket', 'post'),
            (e ->> 'planned_start')::date, (e ->> 'planned_end')::date,
            COALESCE((e ->> 'weight')::numeric, 1), 'reserved',
            v_cycle_id);
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
    'rows', v_n_rows,
    'snapshot_hash', v_hash);
END $$;

COMMENT ON CONSTRAINT mos_task_reservations_one_subject ON public.mos_task_reservations IS
  'A reservation names AT MOST one subject: a content item (content_id) or a row (row_id), never '
  'both. Neither is the deferred paid shell — a creative slot for a later refresh round, whose '
  'mos_content is created lazily by mos_plan_start_due, which binds the reservation by cycle_id + '
  'content_key. cycle_id is therefore MANDATORY on a subject-less reservation and '
  'mos_campaign_plan_commit refuses one without it (MOS:UNBINDABLE_RESERVATION): until '
  '2026-09-15_23 nothing wrote that column, the bind matched nothing, and every deferred paid '
  'reservation charged its assignee''s capacity forever. A row reservation that cannot be resolved '
  'is refused with MOS:UNKNOWN_ROW_KEY, which names the key; a check violation would not.';

-- ────────────────────────────────────────────────────────────────────────────
-- Standing guards, same as 2026-09-15_22, plus one for this fix.
-- ────────────────────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('mos_campaign_plan_commit', 'mos_campaign_plan_commit_month')
     AND has_function_privilege('anon', p.oid, 'EXECUTE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'MOS:ANON_CAN_EXECUTE — %', v_bad;
  END IF;
END $assert$;

DO $assert$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('mos_campaign_plan_commit', 'mos_campaign_plan_commit_month')
     AND pg_get_functiondef(p.oid) ~ '''40001''|''40P01''|serialization_failure|deadlock_detected';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'MOS:RETRYABLE_SQLSTATE in %', v_bad;
  END IF;
END $assert$;

-- B4's own guard: the commit must still know the three things it was blind to.
DO $assert$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mos_campaign_plan_commit';
  IF position('mos_content_rows' IN v_def) = 0
     OR position('row_key' IN v_def) = 0
     OR position('placement_variant' IN v_def) = 0 THEN
    RAISE EXCEPTION 'MOS:B4_NOT_APPLIED — rows=% row_key=% variant=%',
      position('mos_content_rows' IN v_def) > 0,
      position('row_key' IN v_def) > 0,
      position('placement_variant' IN v_def) > 0;
  END IF;
END $assert$;

-- THIS file's guard. The bind is only closed while the commit resolves
-- `cycle_key` and refuses the unbindable shape; a future edit that drops
-- either re-opens a silent capacity leak, so fail the migration instead.
DO $assert$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mos_campaign_plan_commit';
  IF position('cycle_key' IN v_def) = 0
     OR position('MOS:UNBINDABLE_RESERVATION' IN v_def) = 0 THEN
    RAISE EXCEPTION 'MOS:CYCLE_BIND_NOT_APPLIED — cycle_key=% unbindable_guard=%',
      position('cycle_key' IN v_def) > 0,
      position('MOS:UNBINDABLE_RESERVATION' IN v_def) > 0;
  END IF;
END $assert$;

-- And the predicate this whole file exists to feed must still be the one
-- mos_plan_start_due uses. If someone changes the sweep's bind, the planner's
-- cycle_key stops meaning anything and the leak comes back silently.
DO $assert$
DECLARE v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mos_plan_start_due';
  IF v_def IS NULL OR position('cycle_id = r.cycle_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'MOS:SWEEP_BIND_CHANGED — mos_plan_start_due no longer binds deferred reservations by cycle_id';
  END IF;
END $assert$;

COMMIT;
