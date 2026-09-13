-- ============================================================================
-- Campaign planning — ENGINE REWIRE (2026-09-14, part 3 of 4)
-- ----------------------------------------------------------------------------
-- `workflow_role_path_start` and `workflow_advance_role_path` are re-emitted
-- VERBATIM from the LIVE bodies (`SELECT pg_get_functiondef(oid)`, read
-- 2026-09-14) with ONLY these additions — everything else is byte-for-byte the
-- behaviour that is running today:
--
--   (a) the ledger advisory lock, so the workflow serialises against
--       mos_campaign_plan_commit and every other ledger writer;
--   (b) `mos_plan_consume_reservation(new_task_id)` BEFORE the legacy placer —
--       the reservation leaves the ledger as the task enters it (the SWAP);
--       the legacy `mos_perf_place_open_task` runs only when there is no
--       reservation (unplanned content);
--   (c) server-enforced `required_fields` (and `required_files`) read from the
--       PINNED step → `MOS:REQUIREMENTS_MISSING <keys>`;
--   (d) `p_return_to text DEFAULT NULL` — a TARGETED return on
--       changes_requested, validated against the pinned step list: it must be
--       a PRIOR step and it must carry `creates_revision`;
--   (e) a `mos_content_approvals` row on every `p_result='approved'`, binding
--       the exact writing / design / caption / package hashes that were
--       approved.
--
-- Plus two things the additions above depend on:
--   * the LOCKED-FIELD guard triggers (plan §14.11) on mos_content,
--     mos_asset_links, mos_publications.caption and mos_execution_ads.creative;
--   * the ledger lock added to the three OTHER existing ledger writers
--     (`workflow_role_task_transfer`, `mos_perf_task_block`, `mos_leave_decide`),
--     also re-emitted verbatim. An advisory-lock protocol only works if EVERY
--     writer takes the lock; leaving these three out would leave the hole open.
--
-- Idempotent.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. workflow_role_path_start — verbatim + (a) lock + (b) consume
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
  -- (a) THE LEDGER LOCK, FIRST STATEMENT. This function creates a ledger row,
  -- and it must serialise against mos_campaign_plan_commit even on the path
  -- where no reservation exists (unplanned content), because the legacy
  -- placer assigns a person inside that window.
  PERFORM public.mos_ledger_lock();

  IF p_subject_table <> 'mos_content' THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- The creation right, not the assignment right.
  -- 2026-09-14: auth.uid() IS NULL means service_role (anon has been revoked
  -- below), which is how the 10-minute planning sweep opens due work.
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('write_content') THEN
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

  -- (b) THE SWAP. A planned step takes its assignee, window, effort and due
  -- date from the reservation the plan booked; the reservation leaves the
  -- ledger in the same breath. Only unplanned content falls through to the
  -- capacity-aware placer (2026-08-28).
  IF public.mos_plan_consume_reservation(v_new_id) IS NULL THEN
    PERFORM public.mos_perf_place_open_task(v_new_id);
  END IF;

  RETURN jsonb_build_object('opened_task_id', v_new_id, 'already_open', false);
END $function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. workflow_advance_role_path — verbatim + (a)…(e)
-- ----------------------------------------------------------------------------
-- The 6-argument version MUST be dropped: with a 7th defaulted parameter both
-- would match a 6-argument call and Postgres would refuse it as ambiguous.
-- ────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.workflow_advance_role_path(text, uuid, text, text, jsonb, boolean);

CREATE OR REPLACE FUNCTION public.workflow_advance_role_path(
  p_subject_table text,
  p_subject_id uuid,
  p_result text,
  p_note text DEFAULT NULL::text,
  p_targets jsonb DEFAULT '[]'::jsonb,
  p_finish boolean DEFAULT false,
  p_return_to text DEFAULT NULL::text)
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
  v_step      jsonb;
  v_missing   text[];
  v_ret_idx   integer;
BEGIN
  -- (a) THE LEDGER LOCK, FIRST STATEMENT. Highest-blast-radius function in the
  -- module: it closes one ledger row and opens another. Reaching the lock only
  -- indirectly through mos_plan_consume_reservation would leave every legacy
  -- (unplanned) item advancing with no lock at all.
  PERFORM public.mos_ledger_lock();

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
  IF p_result = 'changes_requested'
     AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED';
  END IF;

  SELECT c.workflow_version_id, v.definition->'metadata'->'steps'
    INTO v_version, v_steps
    FROM public.mos_content c
    LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
   WHERE c.id = p_subject_id;

  -- ── (c) server-enforced requirements, read from the PINNED step ─────────
  -- Until now `required_fields` / `required_files` were decoration: the step
  -- carried them and nothing checked them. A submit or an approve now refuses
  -- with the exact list of what is missing.
  IF p_result IN ('submitted','approved') AND v_steps IS NOT NULL
     AND jsonb_typeof(v_steps) = 'array' THEN
    SELECT e.elem INTO v_step
      FROM jsonb_array_elements(v_steps) e(elem)
     WHERE e.elem ->> 'key' = v_task.step_key
     LIMIT 1;

    v_missing := ARRAY[]::text[];

    SELECT COALESCE(v_missing || array_agg(q.k), v_missing) INTO v_missing
      FROM (
        SELECT COALESCE(f ->> 'key', f #>> '{}') AS k
          FROM jsonb_array_elements(COALESCE(v_step -> 'required_fields', '[]'::jsonb)) f) q
     WHERE q.k IS NOT NULL
       AND NULLIF(btrim(COALESCE(
             (SELECT c.data ->> q.k FROM public.mos_content c WHERE c.id = p_subject_id), '')), '') IS NULL;

    SELECT COALESCE(v_missing || array_agg(q.k), v_missing) INTO v_missing
      FROM (
        SELECT COALESCE(f ->> 'role', f #>> '{}') AS k
          FROM jsonb_array_elements(COALESCE(v_step -> 'required_files', '[]'::jsonb)) f) q
     WHERE q.k IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.mos_asset_links al
                        WHERE al.content_id = p_subject_id AND al.role = q.k
                          AND al.superseded_at IS NULL);

    -- The caption CONFIRMATION is not a plain field, so `required_fields`
    -- alone cannot express it: a step that requires `caption` also requires
    -- the writer to have confirmed THAT EXACT TEXT. Exact string comparison,
    -- no trimming on either side -- a JS/SQL trim-parity mismatch is how the
    -- 2026-08-05 twin-fill bug shipped.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_step -> 'required_fields', '[]'::jsonb)) f
                WHERE COALESCE(f ->> 'key', f #>> '{}') = 'caption')
       AND NOT EXISTS (SELECT 1 FROM public.mos_content c
                        WHERE c.id = p_subject_id
                          AND c.data ->> 'caption_confirmed_text' IS NOT NULL
                          AND c.data ->> 'caption_confirmed_text' = c.data ->> 'caption') THEN
      -- ::text is load-bearing: 'x' alone is UNKNOWN, so text[] || 'x' parses
      -- as array||array and dies with 'malformed array literal'.
      v_missing := v_missing || 'caption_confirmed'::text;
    END IF;

    IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
      RAISE EXCEPTION 'MOS:REQUIREMENTS_MISSING %', array_to_string(v_missing, ', ')
        USING ERRCODE = 'invalid_parameter_value',
              DETAIL  = to_jsonb(v_missing)::text;
    END IF;
  END IF;

  v_closed_by := public.wassell_app_user_id(auth.uid());

  UPDATE public.workflow_role_tasks
     SET status           = 'done',
         result           = p_result,
         note             = p_note,
         revision_targets = COALESCE(p_targets, '[]'::jsonb),
         closed_at        = now(),
         closed_by_user_id = v_closed_by
   WHERE id = v_task.id;

  -- ── (e) bind exactly what was approved ──────────────────────────────────
  IF p_result = 'approved' THEN
    INSERT INTO public.mos_content_approvals
      (content_id, step_key, round, approved_by_user_id, approved_at,
       writing_hash, design_hash, caption_hash, package_hash)
    VALUES (p_subject_id, v_task.step_key, v_task.round, v_closed_by, now(),
            public.mos_content_writing_hash(p_subject_id),
            public.mos_content_design_hash(p_subject_id),
            public.mos_caption_hash((SELECT data ->> 'caption' FROM public.mos_content WHERE id = p_subject_id)),
            public.mos_content_package_hash(p_subject_id))
    ON CONFLICT (content_id, step_key, round) DO UPDATE
      SET approved_by_user_id = EXCLUDED.approved_by_user_id,
          approved_at         = EXCLUDED.approved_at,
          writing_hash        = EXCLUDED.writing_hash,
          design_hash         = EXCLUDED.design_hash,
          caption_hash        = EXCLUDED.caption_hash,
          package_hash        = EXCLUDED.package_hash;

    -- The FINAL approval (the step that hands the item to the ad automation)
    -- closes any open revision — the package is bound again.
    IF COALESCE((v_step ->> 'auto_meta_ad')::boolean, false) THEN
      UPDATE public.mos_content
         SET data = CASE WHEN data ? 'revision'
                         THEN jsonb_set(data, '{revision,closed_at}', to_jsonb(now()))
                         ELSE data END
       WHERE id = p_subject_id;
    END IF;
  END IF;

  IF v_steps IS NULL
     OR jsonb_typeof(v_steps) <> 'array'
     OR jsonb_array_length(v_steps) = 0 THEN
    RETURN jsonb_build_object(
      'closed_task_id', v_task.id, 'opened_task_id', NULL,
      'next_step_key', NULL, 'round', v_task.round, 'done', true);
  END IF;

  -- 2026-09-10: an approval that hands the rest of the path to the ad
  -- automation finishes the item here — no successor task is opened.
  IF p_finish AND p_result = 'approved' THEN
    RETURN jsonb_build_object(
      'closed_task_id', v_task.id, 'opened_task_id', NULL,
      'next_step_key', NULL, 'round', v_task.round, 'done', true);
  END IF;

  SELECT ord - 1 INTO v_idx
    FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
   WHERE elem->>'key' = v_task.step_key;

  IF p_result = 'changes_requested' THEN
    -- ── (d) TARGETED return ───────────────────────────────────────────────
    -- The modal offers the legitimate prior `creates_revision` steps; the
    -- server checks the choice rather than trusting it.
    IF NULLIF(btrim(COALESCE(p_return_to, '')), '') IS NOT NULL THEN
      SELECT ord - 1, elem INTO v_ret_idx, v_next
        FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
       WHERE elem->>'key' = p_return_to
       LIMIT 1;
      IF v_next IS NULL THEN
        RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (not a step in this workflow)', p_return_to
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF v_ret_idx >= COALESCE(v_idx, 0) THEN
        RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (not a prior step)', p_return_to
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF NOT COALESCE((v_next->>'creates_revision')::boolean, false) THEN
        RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (does not create a revision)', p_return_to
          USING ERRCODE = 'invalid_parameter_value';
      END IF;
    ELSE
      SELECT elem INTO v_next
        FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
       WHERE ord - 1 < COALESCE(v_idx, 0)
         AND COALESCE((elem->>'creates_revision')::boolean, false)
       ORDER BY ord DESC
       LIMIT 1;
      IF v_next IS NULL THEN
        v_next := v_steps -> 0;
      END IF;
    END IF;
    v_round := v_task.round + 1;
  ELSE
    IF v_idx IS NOT NULL AND v_idx < jsonb_array_length(v_steps) - 1 THEN
      v_next := v_steps -> (v_idx + 1);
    ELSE
      v_next := NULL;
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

    -- (b) THE SWAP, before the legacy placer.
    IF public.mos_plan_consume_reservation(v_new_id) IS NULL THEN
      PERFORM public.mos_perf_place_open_task(v_new_id);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'closed_task_id', v_task.id,
    'opened_task_id', v_new_id,
    'next_step_key',  CASE WHEN v_next IS NULL THEN NULL ELSE v_next->>'key' END,
    'round',          v_round,
    'done',           v_next IS NULL);
END $function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. The other three ledger writers — verbatim + the lock
-- ----------------------------------------------------------------------------
-- An advisory-lock protocol is only as strong as its least disciplined writer.
-- These three move due dates / assignees of OPEN tasks, i.e. ledger rows.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.workflow_role_task_transfer(p_task_id uuid, p_to_user_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_task public.workflow_role_tasks%ROWTYPE;
BEGIN
  PERFORM public.mos_ledger_lock();

  IF NOT (public.wassell_mos_can('manage_roles') OR public.wassell_mos_can('assign')) THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_task FROM public.workflow_role_tasks
   WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:TASK_NOT_FOUND';
  END IF;
  IF v_task.status <> 'open' THEN
    RAISE EXCEPTION 'MOS:TASK_NOT_OPEN';
  END IF;

  UPDATE public.workflow_role_tasks
     SET assignee_user_id = p_to_user_id,
         note = COALESCE(note, '')
              || E'\ntransferred by ' || public.wassell_app_user_id(auth.uid())::text
              || ' at ' || now()::text,
         updated_at = now()
   WHERE id = p_task_id;
END $function$;

CREATE OR REPLACE FUNCTION public.mos_perf_task_block(p_task_source text, p_task_id uuid, p_blocked boolean, p_reason text DEFAULT NULL::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_by uuid := public.wassell_app_user_id(auth.uid());
BEGIN
  PERFORM public.mos_ledger_lock();

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
END $function$;

CREATE OR REPLACE FUNCTION public.mos_leave_decide(p_leave_id uuid, p_approve boolean)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_leave public.mos_leaves%ROWTYPE;
  v_shift interval;
BEGIN
  PERFORM public.mos_ledger_lock();

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
END $function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4. The LOCKED-FIELD guard (plan §9.3 / §14.11)
-- ----------------------------------------------------------------------------
-- Once a step's approval row binds a package, that package's fields are LOCKED.
-- An edit is refused with `MOS:LOCKED …` unless a revision is open
-- (`content_revise` opens one; the final approval closes it).
--
-- SERVER-SIDE WRITES ARE EXEMPT (`auth.uid() IS NULL` = service_role): the
-- Meta worker parks captions on `mos_execution_ads.creative` and the sweeps
-- patch content, and blocking them would break the running caption-review flow.
-- Same posture as the existing `mos_tg_manual_task_guard`.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mos_revision_is_open(p_content_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE((SELECT (c.data -> 'revision') IS NOT NULL
                      AND (c.data -> 'revision' ->> 'closed_at') IS NULL
                     FROM public.mos_content c WHERE c.id = p_content_id), false);
$$;

-- Is there an approval row binding the package the row currently shows?
CREATE OR REPLACE FUNCTION public.mos_content_is_locked(p_content_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM public.mos_content_approvals a
                  WHERE a.content_id = p_content_id)
     AND NOT public.mos_revision_is_open(p_content_id);
$$;

CREATE OR REPLACE FUNCTION public.mos_tg_content_locked_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_old_w text; v_new_w text; v_old_c text; v_new_c text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;              -- service_role
  IF NOT public.mos_content_is_locked(NEW.id) THEN RETURN NEW; END IF;

  -- Only the WRITING package and the caption are locked. Notes, tags,
  -- lifecycle columns and everything outside `field_schema` stay editable.
  v_old_c := public.mos_caption_hash(OLD.data ->> 'caption');
  v_new_c := public.mos_caption_hash(NEW.data ->> 'caption');
  IF v_old_c IS DISTINCT FROM v_new_c THEN
    RAISE EXCEPTION 'MOS:LOCKED caption — open a revision (content_revise) first'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.title IS DISTINCT FROM NEW.title THEN
    RAISE EXCEPTION 'MOS:LOCKED title — open a revision (content_revise) first'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT string_agg(q.k || '=' || COALESCE(OLD.data ->> q.k, ''), '|' ORDER BY q.k),
         string_agg(q.k || '=' || COALESCE(NEW.data ->> q.k, ''), '|' ORDER BY q.k)
    INTO v_old_w, v_new_w
    FROM (SELECT DISTINCT COALESCE(f ->> 'key', f #>> '{}') AS k
            FROM public.mos_content_types ct,
                 LATERAL jsonb_array_elements(COALESCE(ct.field_schema, '[]'::jsonb)) f
           WHERE ct.id = NEW.content_type_id) q
   WHERE q.k IS NOT NULL
     AND q.k NOT IN ('caption','hashtags','notes','caption_confirmed_text','caption_confirmed_at',
                        'caption_confirmed_hash','caption_confirmed_by_writer_at');

  IF v_old_w IS DISTINCT FROM v_new_w THEN
    RAISE EXCEPTION 'MOS:LOCKED writing package — open a revision (content_revise) first'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mos_content_locked_guard_tg ON public.mos_content;
CREATE TRIGGER mos_content_locked_guard_tg
  BEFORE UPDATE ON public.mos_content
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_content_locked_guard();

CREATE OR REPLACE FUNCTION public.mos_tg_asset_link_locked_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_content uuid; v_role text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  v_content := COALESCE(NEW.content_id, OLD.content_id);
  v_role    := COALESCE(NEW.role, OLD.role);
  -- only the design SLOTS are part of the approved package
  IF v_role NOT IN ('final','final_square','final_vertical') THEN RETURN COALESCE(NEW, OLD); END IF;
  -- superseding a slot IS how a new version lands; that is allowed
  IF TG_OP = 'UPDATE' AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF public.mos_content_is_locked(v_content) THEN
    RAISE EXCEPTION 'MOS:LOCKED design slot % — open a revision (content_revise) first', v_role
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS mos_asset_links_locked_guard_tg ON public.mos_asset_links;
CREATE TRIGGER mos_asset_links_locked_guard_tg
  BEFORE INSERT OR UPDATE OR DELETE ON public.mos_asset_links
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_asset_link_locked_guard();

-- A SCHEDULED publication may be updated in place; a PUBLISHED one is never
-- touched (§9.3 — the offer is a new post, not a rewrite of history).
CREATE OR REPLACE FUNCTION public.mos_tg_publication_caption_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF OLD.caption IS DISTINCT FROM NEW.caption AND OLD.status = 'published' THEN
    RAISE EXCEPTION 'MOS:LOCKED published caption — a published post is never rewritten'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mos_publications_caption_guard_tg ON public.mos_publications;
CREATE TRIGGER mos_publications_caption_guard_tg
  BEFORE UPDATE ON public.mos_publications
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_publication_caption_guard();

-- A RUNNING ad is never edited in place (§9.3 / §7.5): the replacement is built
-- PAUSED, activated, verified, and only then the old one is retired.
CREATE OR REPLACE FUNCTION public.mos_tg_execution_ad_creative_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF OLD.creative IS DISTINCT FROM NEW.creative
     AND OLD.status = 'running' AND OLD.platform_ad_id IS NOT NULL
     AND NEW.retired_at IS NULL THEN
    RAISE EXCEPTION 'MOS:LOCKED running creative — build a replacement, activate it, then retire this one'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS mos_execution_ads_creative_guard_tg ON public.mos_execution_ads;
CREATE TRIGGER mos_execution_ads_creative_guard_tg
  BEFORE UPDATE ON public.mos_execution_ads
  FOR EACH ROW EXECUTE FUNCTION public.mos_tg_execution_ad_creative_guard();

-- ────────────────────────────────────────────────────────────────────────────
-- 5. Grants
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig, p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('workflow_role_path_start','workflow_advance_role_path',
                         'workflow_role_task_transfer','mos_perf_task_block','mos_leave_decide',
                         'mos_revision_is_open','mos_content_is_locked',
                         'mos_tg_content_locked_guard','mos_tg_asset_link_locked_guard',
                         'mos_tg_publication_caption_guard','mos_tg_execution_ad_creative_guard')
  LOOP
    -- anon must never reach these: `auth.uid() IS NULL` is how the sweep and
    -- the worker are recognised as server-side, and anon shares that shape.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', r.sig);
    IF r.proname LIKE 'mos_tg_%' THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', r.sig);
    END IF;
  END LOOP;
END $$;
