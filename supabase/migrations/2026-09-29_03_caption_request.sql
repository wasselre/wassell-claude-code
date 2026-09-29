-- 2026-09-29 — A finished post can be sent back to the writer for a caption only.
--
-- WHY. 23 older organic posts (created 31 Aug–7 Sep, before posts had a caption
-- field) were approved with their text on the image only. Eleven of them were
-- never published (P-142, P-146, P-148, P-150…P-157), and a feed post cannot go
-- out without an approved caption (the platform rulebook blocks it by design).
-- The operator chose the normal route (2026-09-29, option "A"): the WRITER
-- writes each caption and the MANAGER approves it.
--
-- (1) workflow_advance_role_path — re-emitted from the LIVE definition; the only
--     change honours an open revision's `skip_steps`. content_revise has written
--     that list for caption-only revisions since 2026-09-14 but no code read it,
--     so a caption fix went back through design. Now: writing → writing_review →
--     (design and design_writer_review skipped) → design_review, the final
--     approval, which records the approval + hashes the publish gate checks.
-- (2) mos_content_request_caption(content, note) — opens the WRITING step on a
--     finished, finally-approved post as a caption-only revision (the
--     content_revise shape, but the writer's step first: content_revise opens the
--     manager's review directly, which assumes the manager edits the text).
--     Service role only.
--
-- Nothing here raises SQLSTATE 40001/40P01.
BEGIN;

-- ── (1) the engine, honouring skip_steps ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.workflow_advance_role_path(p_subject_table text, p_subject_id uuid, p_result text, p_note text DEFAULT NULL::text, p_targets jsonb DEFAULT '[]'::jsonb, p_finish boolean DEFAULT false, p_return_to text DEFAULT NULL::text, p_task_id uuid DEFAULT NULL::uuid, p_event_id uuid DEFAULT NULL::uuid, p_operation text DEFAULT NULL::text, p_request_hash text DEFAULT NULL::text, p_request_snapshot jsonb DEFAULT NULL::jsonb, p_meta_target jsonb DEFAULT NULL::jsonb, p_submission_snapshot jsonb DEFAULT NULL::jsonb)
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
  v_skip      jsonb;
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
  v_paid      boolean := false;
  v_replay    jsonb;
  v_operation text := COALESCE(p_operation, CASE WHEN p_subject_table = 'mos_content_rows' THEN 'row.complete' ELSE 'content.complete' END);
  v_effects   jsonb := '[]'::jsonb;
  v_outcome   jsonb;
  v_caption   text; v_chash text;
  snap        jsonb;
BEGIN
  PERFORM public.mos_ledger_lock();

  IF p_subject_table NOT IN ('mos_content', 'mos_content_rows') THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table USING ERRCODE = 'feature_not_supported';
  END IF;
  v_is_row := p_subject_table = 'mos_content_rows';
  v_closed_by := public.wassell_app_user_id(auth.uid());

  -- (1) replay, first
  v_replay := public.mos_completion_replay(p_event_id, v_operation, p_task_id, p_request_hash, v_closed_by);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  -- (2) the SPECIFIC task when named; the subject's open task otherwise (legacy callers)
  IF p_task_id IS NOT NULL THEN
    SELECT * INTO v_task FROM public.workflow_role_tasks
     WHERE id = p_task_id AND subject_table = p_subject_table AND subject_id = p_subject_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'MOS:TASK_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_task.status <> 'open' THEN
      RAISE EXCEPTION 'MOS:TASK_ALREADY_CLOSED' USING ERRCODE = 'WS409',
        DETAIL = jsonb_build_object('task_id', p_task_id, 'status', v_task.status, 'result', v_task.result)::text;
    END IF;
  ELSE
    SELECT * INTO v_task FROM public.workflow_role_tasks
     WHERE subject_table = p_subject_table AND subject_id = p_subject_id AND status = 'open' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'MOS:NO_OPEN_TASK'; END IF;
  END IF;

  v_roles := public.wassell_mos_roles(auth.uid());
  IF NOT (
       'administrator'     = ANY(v_roles)
    OR 'marketing_manager' = ANY(v_roles)
    OR v_task.role_key     = ANY(v_roles)
    OR COALESCE(v_task.assignee_user_id = v_closed_by, false)
  ) THEN
    RAISE EXCEPTION 'MOS:NOT_YOUR_TASK' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_result NOT IN ('submitted','approved','changes_requested') THEN
    RAISE EXCEPTION 'MOS:BAD_RESULT %', p_result;
  END IF;
  IF p_result = 'changes_requested' AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED';
  END IF;

  IF v_is_row THEN
    SELECT r.workflow_version_id, v.definition->'metadata'->'steps' INTO v_version, v_steps
      FROM public.mos_content_rows r LEFT JOIN public.workflow_versions v ON v.id = r.workflow_version_id
     WHERE r.id = p_subject_id;
    SELECT count(*) INTO v_members FROM public.mos_content c WHERE c.row_id = p_subject_id;
    IF v_members = 0 THEN
      RAISE EXCEPTION 'MOS:ROW_EMPTY % (no posts belong to this row)', p_subject_id USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    SELECT c.workflow_version_id, v.definition->'metadata'->'steps', (c.purpose IN ('paid','both'))
      INTO v_version, v_steps, v_paid
      FROM public.mos_content c LEFT JOIN public.workflow_versions v ON v.id = c.workflow_version_id
     WHERE c.id = p_subject_id;
  END IF;

  SELECT e.elem INTO v_step FROM jsonb_array_elements(COALESCE(v_steps, '[]'::jsonb)) e(elem)
   WHERE e.elem ->> 'key' = v_task.step_key LIMIT 1;

  -- (3) server-enforced requirements, per member
  IF p_result IN ('submitted','approved') AND v_steps IS NOT NULL AND jsonb_typeof(v_steps) = 'array' THEN
    v_missing := ARRAY[]::text[];
    FOR v_m IN
      SELECT c.id, COALESCE(NULLIF(btrim(c.ref), ''), NULLIF(btrim(c.title), ''), c.id::text) AS label
        FROM public.mos_content c
       WHERE (v_is_row AND c.row_id = p_subject_id) OR (NOT v_is_row AND c.id = p_subject_id)
       ORDER BY c.row_order NULLS LAST, c.created_at
    LOOP
      v_m_missing := ARRAY[]::text[];
      SELECT COALESCE(v_m_missing || array_agg(q.k), v_m_missing) INTO v_m_missing
        FROM (SELECT COALESCE(f ->> 'key', f #>> '{}') AS k
                FROM jsonb_array_elements(COALESCE(v_step -> 'required_fields', '[]'::jsonb)) f) q
       WHERE q.k IS NOT NULL
         AND NULLIF(btrim(COALESCE((SELECT c.data ->> q.k FROM public.mos_content c WHERE c.id = v_m.id), '')), '') IS NULL;
      SELECT COALESCE(v_m_missing || array_agg(q.k), v_m_missing) INTO v_m_missing
        FROM (SELECT COALESCE(f ->> 'role', f #>> '{}') AS k
                FROM jsonb_array_elements(COALESCE(v_step -> 'required_files', '[]'::jsonb)) f) q
       WHERE q.k IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.mos_asset_links al
                          WHERE al.content_id = v_m.id AND al.role = q.k AND al.superseded_at IS NULL);
      -- the writer's caption must be CONFIRMED where the step requires the caption
      -- (writing), and — D4 — at the LAUNCH step of a paid creative: the final
      -- approval launches the ad with exactly this caption, so there is nothing
      -- to approve later.
      IF (EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_step -> 'required_fields', '[]'::jsonb)) f
                   WHERE COALESCE(f ->> 'key', f #>> '{}') = 'caption')
          OR (p_result = 'approved' AND v_paid AND COALESCE((v_step ->> 'auto_meta_ad')::boolean, false)))
         AND NOT EXISTS (SELECT 1 FROM public.mos_content c
                          WHERE c.id = v_m.id
                            AND NULLIF(btrim(COALESCE(c.data ->> 'caption', '')), '') IS NOT NULL
                            AND c.data ->> 'caption_confirmed_text' IS NOT NULL
                            AND c.data ->> 'caption_confirmed_text' = c.data ->> 'caption') THEN
        v_m_missing := v_m_missing || 'caption_confirmed'::text;
      END IF;
      IF COALESCE(array_length(v_m_missing, 1), 0) > 0 THEN
        IF v_is_row THEN
          SELECT COALESCE(v_missing || array_agg(v_m.label || ' — ' || u.k ORDER BY u.ord), v_missing)
            INTO v_missing FROM unnest(v_m_missing) WITH ORDINALITY AS u(k, ord);
        ELSE
          v_missing := v_missing || v_m_missing;
        END IF;
      END IF;
    END LOOP;
    IF COALESCE(array_length(v_missing, 1), 0) > 0 THEN
      RAISE EXCEPTION 'MOS:REQUIREMENTS_MISSING %', array_to_string(v_missing, ', ')
        USING ERRCODE = 'invalid_parameter_value', DETAIL = to_jsonb(v_missing)::text;
    END IF;
  END IF;

  -- (4) immutable evidence, inside the transition (§5c): only for a FRESH
  -- 'submitted' of the LOCKED round; the reject note on the round being rejected.
  IF p_result = 'submitted' AND p_submission_snapshot IS NOT NULL AND jsonb_typeof(p_submission_snapshot) = 'array' THEN
    FOR snap IN SELECT * FROM jsonb_array_elements(p_submission_snapshot) LOOP
      INSERT INTO public.mos_content_versions (content_id, round, data, scenes, submitted_by_user_id)
      VALUES ((snap ->> 'content_id')::uuid, v_task.round, COALESCE(snap -> 'data', '{}'::jsonb),
              COALESCE(snap -> 'scenes', '[]'::jsonb), v_closed_by)
      ON CONFLICT (content_id, round) DO UPDATE
        SET data = EXCLUDED.data, scenes = EXCLUDED.scenes, submitted_by_user_id = EXCLUDED.submitted_by_user_id;
    END LOOP;
  END IF;
  IF p_result = 'changes_requested' THEN
    UPDATE public.mos_content_versions cv SET rejected_note = p_note
     WHERE cv.round = v_task.round
       AND cv.content_id IN (SELECT c.id FROM public.mos_content c
                              WHERE (v_is_row AND c.row_id = p_subject_id) OR (NOT v_is_row AND c.id = p_subject_id));
  END IF;

  -- (5) the transition
  UPDATE public.workflow_role_tasks
     SET status = 'done', result = p_result, note = p_note,
         revision_targets = COALESCE(p_targets, '[]'::jsonb),
         closed_at = now(), closed_by_user_id = v_closed_by,
         offered_to_user_id = NULL, offered_at = NULL
   WHERE id = v_task.id;

  IF p_result = 'approved' THEN
    INSERT INTO public.mos_content_approvals
      (content_id, step_key, round, approved_by_user_id, approved_at, writing_hash, design_hash, caption_hash, package_hash)
    SELECT c.id, v_task.step_key, v_task.round, v_closed_by, now(),
           public.mos_content_writing_hash(c.id), public.mos_content_design_hash(c.id),
           public.mos_caption_hash(c.data ->> 'caption'), public.mos_content_package_hash(c.id)
      FROM public.mos_content c
     WHERE (v_is_row AND c.row_id = p_subject_id) OR (NOT v_is_row AND c.id = p_subject_id)
    ON CONFLICT (content_id, step_key, round) DO UPDATE
      SET approved_by_user_id = EXCLUDED.approved_by_user_id, approved_at = EXCLUDED.approved_at,
          writing_hash = EXCLUDED.writing_hash, design_hash = EXCLUDED.design_hash,
          caption_hash = EXCLUDED.caption_hash, package_hash = EXCLUDED.package_hash;

    IF COALESCE((v_step ->> 'auto_meta_ad')::boolean, false) THEN
      UPDATE public.mos_content
         SET data = CASE WHEN data ? 'revision' THEN jsonb_set(data, '{revision,closed_at}', to_jsonb(now())) ELSE data END
       WHERE (v_is_row AND row_id = p_subject_id) OR (NOT v_is_row AND id = p_subject_id);

      -- the side-effects manifest (§5e): the approved payload is the writer's
      -- confirmed caption, hashed by the database, snapshotted HERE.
      IF NOT v_is_row THEN
        SELECT c.data ->> 'caption', public.mos_caption_hash(c.data ->> 'caption') INTO v_caption, v_chash
          FROM public.mos_content c WHERE c.id = p_subject_id;
        v_effects := v_effects || jsonb_build_array(jsonb_build_object(
          'kind', 'promote_asset', 'ref', p_subject_id::text, 'status', 'pending', 'attempts', 0));
        IF p_meta_target IS NOT NULL AND p_meta_target ->> 'kind' = 'target' THEN
          v_effects := v_effects || jsonb_build_array(jsonb_build_object(
            'kind', 'meta_ad', 'ref', p_subject_id::text, 'status', 'pending', 'attempts', 0,
            'phase', 'create',
            'job_id', CASE WHEN p_event_id IS NULL THEN NULL ELSE public.mos_meta_job_id(p_event_id) END,
            'target', p_meta_target,
            'approved_caption', jsonb_build_object('text', v_caption, 'hash', v_chash, 'source', 'writer',
                                                   'approved_at', now(), 'approved_by', v_closed_by)));
        END IF;
      END IF;
    END IF;
  END IF;

  -- (6) what opens next
  IF v_steps IS NULL OR jsonb_typeof(v_steps) <> 'array' OR jsonb_array_length(v_steps) = 0
     OR (p_finish AND p_result = 'approved') THEN
    v_next := NULL; v_round := v_task.round;
  ELSE
    SELECT ord - 1 INTO v_idx FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
     WHERE elem->>'key' = v_task.step_key;
    IF p_result = 'changes_requested' THEN
      IF NULLIF(btrim(COALESCE(p_return_to, '')), '') IS NOT NULL THEN
        SELECT ord - 1, elem INTO v_ret_idx, v_next FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
         WHERE elem->>'key' = p_return_to LIMIT 1;
        IF v_next IS NULL THEN
          RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (not a step in this workflow)', p_return_to USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_ret_idx >= COALESCE(v_idx, 0) THEN
          RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (not a prior step)', p_return_to USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF NOT COALESCE((v_next->>'creates_revision')::boolean, false) THEN
          RAISE EXCEPTION 'MOS:BAD_RETURN_TO % (does not create a revision)', p_return_to USING ERRCODE = 'invalid_parameter_value';
        END IF;
      ELSE
        SELECT elem INTO v_next FROM jsonb_array_elements(v_steps) WITH ORDINALITY AS e(elem, ord)
         WHERE ord - 1 < COALESCE(v_idx, 0) AND COALESCE((elem->>'creates_revision')::boolean, false)
         ORDER BY ord DESC LIMIT 1;
        IF v_next IS NULL THEN v_next := v_steps -> 0; END IF;
      END IF;
      v_round := v_task.round + 1;
    ELSE
      IF v_idx IS NOT NULL AND v_idx < jsonb_array_length(v_steps) - 1 THEN
        v_next := v_steps -> (v_idx + 1);
      ELSE
        v_next := NULL;
      END IF;
      -- (2026-09-29) Honour an OPEN revision's skip list. content_revise has
      -- written `skip_steps` (design, design_writer_review) for a caption-only
      -- revision since 2026-09-14, but nothing read it — so fixing a caption on
      -- an approved post sent it back to the designer. Only a single content
      -- item carries a revision; a row never does. The final approval step is
      -- never in the list, so the chain still ends with a recorded approval.
      IF v_next IS NOT NULL AND NOT v_is_row THEN
        SELECT COALESCE(c.data -> 'revision' -> 'skip_steps', '[]'::jsonb) INTO v_skip
          FROM public.mos_content c
         WHERE c.id = p_subject_id
           AND c.data ? 'revision'
           AND (c.data -> 'revision' ->> 'closed_at') IS NULL;
        WHILE v_next IS NOT NULL
              AND COALESCE(v_skip, '[]'::jsonb) @> jsonb_build_array(v_next ->> 'key') LOOP
          v_idx := v_idx + 1;
          v_next := CASE WHEN v_idx < jsonb_array_length(v_steps) - 1 THEN v_steps -> (v_idx + 1) END;
        END LOOP;
      END IF;
      v_round := v_task.round;
    END IF;
    IF v_next IS NOT NULL THEN
      v_new_id := public.mos_task_open_step(p_subject_table, p_subject_id, v_version, v_next, v_round);
    END IF;
  END IF;

  v_outcome := jsonb_build_object(
    'closed_task_id', v_task.id, 'opened_task_id', v_new_id,
    'next_step_key', CASE WHEN v_next IS NULL THEN NULL ELSE v_next->>'key' END,
    'round', v_round, 'done', v_next IS NULL, 'event_id', p_event_id);

  -- (7) the event, LAST (rollback removes event and transition together)
  IF p_event_id IS NOT NULL THEN
    INSERT INTO public.mos_completion_events
      (event_id, operation, task_id, subject_table, subject_id, actor_user_id, request_hash,
       request_snapshot, outcome, side_effects)
    VALUES (p_event_id, v_operation, v_task.id, p_subject_table, p_subject_id, v_closed_by,
            COALESCE(p_request_hash, ''), COALESCE(p_request_snapshot, '{}'::jsonb), v_outcome, v_effects);
  END IF;

  -- (8) the decider runs for the next holder's role — immediacy without recursion
  IF v_new_id IS NOT NULL THEN
    PERFORM public.mos_refill_request(ARRAY[v_next ->> 'role_key']);
  ELSE
    PERFORM public.mos_refill_request(ARRAY[v_task.role_key]);
  END IF;

  RETURN v_outcome || jsonb_build_object('side_effects', v_effects);
END $function$;

-- ── (2) caption request ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mos_content_request_caption(p_content_id uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_c     public.mos_content%ROWTYPE;
  v_ver   uuid;
  v_step  jsonb;
  v_round int;
  v_new   uuid;
BEGIN
  PERFORM public.mos_ledger_lock();
  IF NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_c FROM public.mos_content WHERE id = p_content_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:CONTENT_NOT_FOUND %', p_content_id USING ERRCODE = 'no_data_found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflow_role_tasks t
              WHERE t.subject_table = 'mos_content' AND t.subject_id = p_content_id AND t.status = 'open') THEN
    RAISE EXCEPTION 'MOS:CONTENT_IN_PROGRESS % already has an open step', v_c.ref USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only a post that passed its FINAL approval: this is a caption on finished
  -- work, not a way to skip the design of unfinished work.
  IF NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                  WHERE t.subject_table = 'mos_content' AND t.subject_id = p_content_id
                    AND t.step_key = 'design_review' AND t.result = 'approved') THEN
    RAISE EXCEPTION 'MOS:NOT_FINALLY_APPROVED %', v_c.ref USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_ver := v_c.workflow_version_id;
  SELECT e.elem INTO v_step
    FROM public.workflow_versions v, LATERAL jsonb_array_elements(v.definition -> 'metadata' -> 'steps') e(elem)
   WHERE v.id = v_ver AND e.elem ->> 'key' = 'writing' LIMIT 1;
  IF v_step IS NULL THEN
    RAISE EXCEPTION 'MOS:NO_WRITING_STEP % on version %', v_c.ref, v_ver USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_round := COALESCE((SELECT max(round) FROM public.workflow_role_tasks
                        WHERE subject_table = 'mos_content' AND subject_id = p_content_id), 0) + 1;

  UPDATE public.mos_content
     SET data = (((((data - 'caption_confirmed_text') - 'caption_confirmed_at') - 'caption_confirmed_hash')
                   - 'caption_confirmed_by_writer_at')
                 || jsonb_build_object('revision', jsonb_build_object(
                      'round', v_round, 'scope', jsonb_build_array('caption'), 'note', p_note,
                      'opened_at', now(), 'reason', 'caption_request',
                      'skip_steps', jsonb_build_array('design', 'design_writer_review')))),
         on_hold_at = NULL, rejected_at = NULL
   WHERE id = p_content_id;

  INSERT INTO public.mos_content_events (content_id, kind, actor_user_id, detail)
  VALUES (p_content_id, 'revision_opened', NULL,
          jsonb_build_object('scope', jsonb_build_array('caption'), 'note', p_note, 'round', v_round,
                             'reason', 'caption_request'));

  v_new := public.mos_task_open_step('mos_content', p_content_id, v_ver, v_step, v_round);
  PERFORM public.mos_refill_request(ARRAY[v_step ->> 'role_key']);
  RETURN jsonb_build_object('content_id', p_content_id, 'ref', v_c.ref, 'round', v_round, 'opened_task_id', v_new);
END $function$;

REVOKE ALL ON FUNCTION public.mos_content_request_caption(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mos_content_request_caption(uuid, text) TO service_role;

-- ── assertions ────────────────────────────────────────────────────────────────
DO $assert$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.workflow_advance_role_path(text, uuid, text, text, jsonb, boolean, text, uuid, uuid, text, text, jsonb, jsonb, jsonb)'::regprocedure);
  IF position('skip_steps' IN v_def) = 0 THEN
    RAISE EXCEPTION 'CAPTION_REQUEST: workflow_advance_role_path does not honour skip_steps';
  END IF;
  IF has_function_privilege('authenticated', 'public.mos_content_request_caption(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'CAPTION_REQUEST: mos_content_request_caption is callable from the browser';
  END IF;
END $assert$;

COMMIT;
