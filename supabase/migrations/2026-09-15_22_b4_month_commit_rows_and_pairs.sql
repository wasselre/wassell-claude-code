-- ============================================================================
-- B4 — the month reaches the database. 2026-09-15.
--
-- Everything else of the monthly operating model is built and live; the engine
-- compiled a perfect month and NOTHING persisted it. `materialisePayload`
-- emits `rows[]`, `releases[]`, `items[].row_key/row_order` and
-- `reservations[].row_key/spread/weights`, and `mos_campaign_plan_commit`
-- carried every one of them and ignored it. Verified on production minutes
-- before this file was written:
--
--     mos_campaign_plan_commit: knows mos_content_rows   = false
--                               knows row_key            = false
--                               writes placement_variant = false
--
-- so `month_confirm` committed four plans and then counted what it expected,
-- returning warnings: ["rows_not_materialised:0/16"].
--
-- WHAT THIS FILE DOES
--
--   1. mos_content_rows are materialised from `rows[]`, pinned to the members'
--      own workflow version (A11: post_std v8 / video_std v7), and each member
--      is linked through mos_content.row_id + .row_order. project_id stays
--      NULL for the Saturday general row — a quarter of the organic month.
--   2. A reservation names EXACTLY ONE subject. A row reservation sets row_id
--      and leaves content_id NULL; `mos_plan_start_due` opens the row's task
--      off row_id, so an unresolvable row key is refused BY NAME rather than
--      left as a reservation nothing can find.
--   3. TWO publications per organic post, from the STATED `releases[]` key
--      rather than a pair re-derived from `placements[]`: placement_variant,
--      pair_id and the per-release planned_at that already encodes the
--      reversal (the writer's first-read post publishes LAST).
--   4. THE UNIQUE KEY AND THE ON CONFLICT TARGET CHANGE TOGETHER, HERE, IN ONE
--      MIGRATION. A feed release and a story release share content_id, platform
--      and account_id, so under the 3-column key the second was silently
--      swallowed by DO NOTHING — feeds publish, stories do not, nothing errors.
--      Splitting the two halves across two migrations is what broke every
--      organic commit with 42P10 on 2026-09-15 (a 3-column inference cannot
--      match a 4-column expression index); 2026-09-15_03 reverted it and left a
--      COMMENT saying B4 must do both. This does both.
--   5. D8: mos_campaign_plan_commit_month commits all four plans under ONE
--      advisory ledger lock in ONE transaction. Four sequential commits can
--      leave a month half-reserved with no clean undo.
--
-- WHAT THIS FILE DOES NOT CHANGE
--
--   * The advisory ledger lock, the snapshot-hash check and the plan-signature
--     check are untouched.
--   * The WS409 contract: capacity conflicts stay WS409, rate limits WS429, and
--     NOTHING here raises SQLSTATE 40001 / 40P01 — PostgREST retries those
--     forever and that is the documented root cause of this repo's conflict
--     storms (CLAUDE.md, "Never raise SQLSTATE 40001 / 40P01").
--   * The pinned-version guarantee: no statement here rewrites an existing
--     mos_content.workflow_version_id. The 24 live records stay where they are.
--   * The wizard path. `materialisePayload` emits `releases` on every path, and
--     a payload with none falls back to the old one-publication-per-placement
--     loop verbatim.
--
-- ONE CONSTRAINT IS RELAXED, AND IT IS A BUG FIX, NOT A LOOSENING.
--
-- A3 shipped CHECK (num_nonnulls(content_id, row_id) = 1). But the paid lane
-- deliberately creates UNBOUND reservations: an item whose creative slot
-- belongs to a LATER refresh round gets no content shell at commit time (the
-- sweep creates it lazily at production_start_on), while `plan.ts` still emits
-- its reservations — and `mos_plan_start_due` then binds them with
-- `WHERE content_id IS NULL AND row_id IS NULL AND cycle_id = …`. Under "= 1"
-- every paid month plan with more than one round would abort on a check
-- violation, which is three of the month's four plans. The constraint becomes
-- "<= 1" and the loudness moves INTO the RPC, where it can name the offending
-- key (MOS:UNKNOWN_ROW_KEY / MOS:UNKNOWN_ITEM_KEY) instead of raising a check
-- violation that names nothing.
--
-- Idempotent. Safe to re-run.
-- ============================================================================

BEGIN;

-- ── 4. the publication idempotency key, widened ────────────────────────────
-- A unique INDEX rather than a constraint: the key has to include an
-- EXPRESSION (COALESCE(placement_variant,'')) because NULL variants are the
-- legacy/wizard shape and must still collide with each other.
--
-- NOTE, unchanged from S3: account_id is nullable and Postgres treats NULLs as
-- distinct, so this key still does not fire for a publication whose platform
-- has no publishable account (X / @wassel_sa). That is pre-existing and
-- deliberate — such a release surfaces as «الحساب غير موصول».
ALTER TABLE public.mos_publications
  DROP CONSTRAINT IF EXISTS mos_publications_content_id_platform_account_id_key;
DROP INDEX IF EXISTS public.uq_mos_publications_destination;
CREATE UNIQUE INDEX uq_mos_publications_destination
  ON public.mos_publications (content_id, platform, account_id, COALESCE(placement_variant, ''));

COMMENT ON INDEX public.uq_mos_publications_destination IS
  'The destination of ONE release: content x platform x account x placement. The variant is '
  'part of the key because a post publishes twice — feed (square, caption) and story (vertical, '
  'no caption) — to the same account at the same moment. mos_campaign_plan_commit infers this '
  'index by the SAME four-part expression; if you ever change one, change the other in the SAME '
  'migration or every organic commit raises 42P10.';

-- ── the reservation subject rule ───────────────────────────────────────────
-- See the header. "At most one", not "exactly one": a deferred paid shell is
-- legitimately bound to neither until the sweep creates its content.
ALTER TABLE public.mos_task_reservations
  DROP CONSTRAINT IF EXISTS mos_task_reservations_one_subject;
ALTER TABLE public.mos_task_reservations
  ADD CONSTRAINT mos_task_reservations_one_subject
  CHECK (num_nonnulls(content_id, row_id) <= 1) NOT VALID;

COMMENT ON CONSTRAINT mos_task_reservations_one_subject ON public.mos_task_reservations IS
  'A reservation names AT MOST one subject: a content item (content_id) or a row (row_id), never '
  'both. Neither is the deferred paid shell — a creative slot for a later refresh round, whose '
  'mos_content is created lazily by mos_plan_start_due, which then binds the reservation. A row '
  'reservation that cannot be resolved is refused by mos_campaign_plan_commit with '
  'MOS:UNKNOWN_ROW_KEY, which names the key; a check violation would not.';

-- ── 1-3. the commit itself ─────────────────────────────────────────────────
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
            v_n_pub := v_n_pub + 1;
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
      v_n_slot := v_n_slot + 1;
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
    IF NULLIF(e ->> 'row_key', '') IS NULL
       AND NOT (v_item_map ? (e ->> 'item_key')) THEN
      RAISE EXCEPTION 'MOS:UNKNOWN_ITEM_KEY %', e ->> 'item_key'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    INSERT INTO public.mos_task_reservations
      (plan_id, content_id, row_id, content_key, step_key, role_key, assignee_user_id, bucket,
       planned_start, planned_end, weight, status,
       cycle_id)
    VALUES (p_plan_id,
            CASE WHEN v_row_id IS NULL
                 THEN NULLIF(v_item_map ->> (e ->> 'item_key'), '')::uuid END,
            v_row_id,
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
    'rows', v_n_rows,
    'snapshot_hash', v_hash);
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5 (D8). mos_campaign_plan_commit_month — four plans, ONE transaction.
-- ----------------------------------------------------------------------------
-- month_confirm committed the four plans with four separate RPC calls, i.e.
-- four transactions. A failure on the third left a month half-reserved with no
-- clean undo: two campaigns with content, rows, publications and booked
-- capacity, two without, and nothing to roll back to.
--
-- One statement, one transaction, all four or none.
--
-- WHY THE HASH IS CHECKED HERE AND PASSED AS NULL INTO EACH PLAN.
-- mos_workload_snapshot_hash() hashes mos_work_ledger_v, which includes
-- reservations. The moment plan 1 commits, the hash MOVES — inside this very
-- transaction — so re-checking it for plan 2 would refuse every month with
-- plan_changed, always, on the second plan. The gate is therefore taken ONCE,
-- before anything is written, which is exactly what it was ever guarding.
--
-- The per-plan CAPACITY re-check is NOT skipped, and it accumulates correctly:
-- each inner call re-reads mos_work_ledger_v, which already sees the previous
-- plan's reservations in this transaction. Four plans cannot collectively
-- overbook a person without the fourth one noticing.
--
-- mos_ledger_lock() is pg_advisory_xact_lock — re-entrant within one
-- transaction, so the inner calls taking it again is free and the lock is
-- held unbroken from here to COMMIT.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_campaign_plan_commit_month(
  p_plans         jsonb,
  p_expected_hash text,
  p_actor         uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_hash text;
  v_out  jsonb := '[]'::jsonb;
  v_res  jsonb;
  e      jsonb;
  v_n    int := 0;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('approve_plan') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM public.mos_ledger_lock();

  v_hash := public.mos_workload_snapshot_hash();
  IF p_expected_hash IS NOT NULL AND p_expected_hash <> v_hash THEN
    RAISE EXCEPTION 'plan_changed'
      USING ERRCODE = 'WS409',
            DETAIL  = jsonb_build_object('expected', p_expected_hash, 'actual', v_hash)::text,
            HINT    = 'the workload moved since the preview — re-plan the month';
  END IF;

  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_plans, '[]'::jsonb)) LOOP
    IF NULLIF(e ->> 'plan_id', '') IS NULL THEN
      RAISE EXCEPTION 'MOS:PLAN_ID_REQUIRED' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_res := public.mos_campaign_plan_commit(
      (e ->> 'plan_id')::uuid,
      COALESCE(e -> 'reservations', '[]'::jsonb),
      NULL,                                   -- gated once, above. See the note.
      COALESCE(e -> 'materialise', '{}'::jsonb),
      p_actor);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'plan_id', e ->> 'plan_id', 'result', v_res));
    v_n := v_n + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'plans', v_n,
                            'snapshot_hash', v_hash, 'committed', v_out);
END $$;

REVOKE ALL ON FUNCTION public.mos_campaign_plan_commit_month(jsonb, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mos_campaign_plan_commit_month(jsonb, text, uuid)
  TO authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────────────
-- Standing guards, same as 2026-09-15_15.
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

-- The commit must actually know the three things it was blind to.
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

COMMIT;
