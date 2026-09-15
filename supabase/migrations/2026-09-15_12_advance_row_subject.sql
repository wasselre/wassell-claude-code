-- ============================================================================
-- Group C5 — `workflow_advance_role_path` accepts a ROW. 2026-09-15.
--
-- The writing review and the final approval are PER ROW: one submit, one
-- approval, three posts inside it. The engine refused every subject but
-- `mos_content`, so a row could be created and opened but never advanced.
--
-- What changes:
--   * `mos_content_rows` is an accepted subject; the pinned step list is read
--     off `mos_content_rows.workflow_version_id` (a row has no `mos_content`
--     to read it from — that is why the column exists).
--   * `required_fields` / `required_files` are evaluated across ALL THREE
--     members, and the message NAMES the offending member:
--       MOS:REQUIREMENTS_MISSING P-151 — caption, P-152 — final_vertical
--     For a single content item the message and DETAIL keep their exact
--     present shape (a flat list of keys) — no consumer changes.
--   * `approved` writes ONE `mos_content_approvals` row PER MEMBER. That is
--     what makes "send-back is per post and the other two keep their approval"
--     storable with no new partial-approval state, which is why A3 left that
--     table's FK pointing at `mos_content`.
--   * a row with NO members is refused (`MOS:ROW_EMPTY`) instead of advancing
--     with nothing checked — an empty row would otherwise pass every gate.
--
-- Unchanged on purpose: the ledger lock as the first statement, the
-- role/assignee authorization, the WS-safe error codes (never 40001/40P01),
-- the targeted-return validation, and the `p_finish` early exit.
--
-- D1: a pre-cutover item has no `row_id`, so every row branch below is dead
-- for the 24 in-flight records; they keep walking their pinned version.
--
-- Idempotent.
-- ============================================================================

BEGIN;

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
  v_is_row    boolean;
  v_members   integer;
  v_m         record;
  v_m_missing text[];
BEGIN
  -- (a) THE LEDGER LOCK, FIRST STATEMENT. Highest-blast-radius function here:
  -- it closes one ledger row and opens another. Reaching the lock only
  -- indirectly through mos_plan_consume_reservation would leave every legacy
  -- (unplanned) item advancing with no lock at all.
  PERFORM public.mos_ledger_lock();

  IF p_subject_table NOT IN ('mos_content', 'mos_content_rows') THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table
      USING ERRCODE = 'feature_not_supported';
  END IF;
  v_is_row := p_subject_table = 'mos_content_rows';

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

  -- The PINNED step list, off whichever subject holds it.
  IF v_is_row THEN
    SELECT r.workflow_version_id, v.definition->'metadata'->'steps'
      INTO v_version, v_steps
      FROM public.mos_content_rows r
      LEFT JOIN public.workflow_versions v ON v.id = r.workflow_version_id
     WHERE r.id = p_subject_id;

    SELECT count(*) INTO v_members
      FROM public.mos_content c WHERE c.row_id = p_subject_id;
    IF v_members = 0 THEN
      -- An empty row passes every requirement check vacuously. Refuse instead.
      RAISE EXCEPTION 'MOS:ROW_EMPTY % (no posts belong to this row)', p_subject_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    SELECT c.workflow_version_id, v.definition->'metadata'->'steps'
      INTO v_version, v_steps
      FROM public.mos_content c
      LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
     WHERE c.id = p_subject_id;
  END IF;

  -- (c) server-enforced requirements, read from the PINNED step, evaluated for
  -- EVERY member of the subject (one post, or the row's three).
  IF p_result IN ('submitted','approved') AND v_steps IS NOT NULL
     AND jsonb_typeof(v_steps) = 'array' THEN
    SELECT e.elem INTO v_step
      FROM jsonb_array_elements(v_steps) e(elem)
     WHERE e.elem ->> 'key' = v_task.step_key
     LIMIT 1;

    v_missing := ARRAY[]::text[];

    FOR v_m IN
      SELECT c.id, COALESCE(NULLIF(btrim(c.ref), ''), NULLIF(btrim(c.title), ''), c.id::text) AS label
        FROM public.mos_content c
       WHERE (v_is_row AND c.row_id = p_subject_id)
          OR (NOT v_is_row AND c.id = p_subject_id)
       ORDER BY c.row_order NULLS LAST, c.created_at
    LOOP
      v_m_missing := ARRAY[]::text[];

      SELECT COALESCE(v_m_missing || array_agg(q.k), v_m_missing) INTO v_m_missing
        FROM (
          SELECT COALESCE(f ->> 'key', f #>> '{}') AS k
            FROM jsonb_array_elements(COALESCE(v_step -> 'required_fields', '[]'::jsonb)) f) q
       WHERE q.k IS NOT NULL
         AND NULLIF(btrim(COALESCE(
               (SELECT c.data ->> q.k FROM public.mos_content c WHERE c.id = v_m.id), '')), '') IS NULL;

      SELECT COALESCE(v_m_missing || array_agg(q.k), v_m_missing) INTO v_m_missing
        FROM (
          SELECT COALESCE(f ->> 'role', f #>> '{}') AS k
            FROM jsonb_array_elements(COALESCE(v_step -> 'required_files', '[]'::jsonb)) f) q
       WHERE q.k IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.mos_asset_links al
                          WHERE al.content_id = v_m.id AND al.role = q.k
                            AND al.superseded_at IS NULL);

      -- The caption CONFIRMATION is not a plain field: a step that requires
      -- `caption` also requires the writer to have confirmed THAT EXACT TEXT.
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_step -> 'required_fields', '[]'::jsonb)) f
                  WHERE COALESCE(f ->> 'key', f #>> '{}') = 'caption')
         AND NOT EXISTS (SELECT 1 FROM public.mos_content c
                          WHERE c.id = v_m.id
                            AND c.data ->> 'caption_confirmed_text' IS NOT NULL
                            AND c.data ->> 'caption_confirmed_text' = c.data ->> 'caption') THEN
        v_m_missing := v_m_missing || 'caption_confirmed'::text;
      END IF;

      IF COALESCE(array_length(v_m_missing, 1), 0) > 0 THEN
        IF v_is_row THEN
          -- Name the member. "three posts are missing something" is unusable.
          SELECT COALESCE(v_missing || array_agg(v_m.label || ' — ' || u.k ORDER BY u.ord), v_missing)
            INTO v_missing FROM unnest(v_m_missing) WITH ORDINALITY AS u(k, ord);
        ELSE
          v_missing := v_missing || v_m_missing;
        END IF;
      END IF;
    END LOOP;

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

  -- (e) bind exactly what was approved — ONE approval row PER MEMBER, so a
  -- later send-back can reopen one post and leave the other two approved.
  IF p_result = 'approved' THEN
    INSERT INTO public.mos_content_approvals
      (content_id, step_key, round, approved_by_user_id, approved_at,
       writing_hash, design_hash, caption_hash, package_hash)
    SELECT c.id, v_task.step_key, v_task.round, v_closed_by, now(),
           public.mos_content_writing_hash(c.id),
           public.mos_content_design_hash(c.id),
           public.mos_caption_hash(c.data ->> 'caption'),
           public.mos_content_package_hash(c.id)
      FROM public.mos_content c
     WHERE (v_is_row AND c.row_id = p_subject_id)
        OR (NOT v_is_row AND c.id = p_subject_id)
    ON CONFLICT (content_id, step_key, round) DO UPDATE
      SET approved_by_user_id = EXCLUDED.approved_by_user_id,
          approved_at         = EXCLUDED.approved_at,
          writing_hash        = EXCLUDED.writing_hash,
          design_hash         = EXCLUDED.design_hash,
          caption_hash        = EXCLUDED.caption_hash,
          package_hash        = EXCLUDED.package_hash;

    IF COALESCE((v_step ->> 'auto_meta_ad')::boolean, false) THEN
      UPDATE public.mos_content
         SET data = CASE WHEN data ? 'revision'
                         THEN jsonb_set(data, '{revision,closed_at}', to_jsonb(now()))
                         ELSE data END
       WHERE (v_is_row AND row_id = p_subject_id)
          OR (NOT v_is_row AND id = p_subject_id);
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
    -- (d) TARGETED return, validated against the pinned step list.
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

DO $assert$
BEGIN
  IF (SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'workflow_advance_role_path')
     ~ '''40001''|''40P01''|serialization_failure|deadlock_detected' THEN
    RAISE EXCEPTION 'MOS:RETRYABLE_SQLSTATE in workflow_advance_role_path';
  END IF;
END $assert$;

COMMIT;
