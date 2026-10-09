-- 2026-10-09 — Content no longer waits on the Marketing Manager.
--
-- Operator decision: remove BOTH of the manager's content approvals. Before
-- this the post path was
--   writing (writer) → writing_review (MANAGER) → design (montage)
--     → design_writer_review (writer) → design_review (MANAGER, final)
-- and the video path had idea_review / script_review / review on the manager.
-- Now the writer's own design check is the final approval.
--
-- "The final approval" is not a role, it is the step flagged `auto_meta_ad`:
-- the engine writes the binding approval row there, the release gate
-- (api/_lib/marketing/releaseMaterial.ts finalStepKeys) only posts what that
-- step approved, the Meta worker (runMetaAdJob) creates the ad from it, and
-- the UI shows the ad-set panel on it. Moving the flag onto the writer's step
-- moves all four together; no code had the manager's role hard-wired.
--
-- What this migration does, in one transaction:
--   1. Drops every marketing_manager step from the two content paths and moves
--      `auto_meta_ad` onto the last remaining approval (the writer's). The
--      workflows_write_version trigger snapshots this as a new version, which
--      every NEW item pins.
--   2. Re-pins work IN FLIGHT onto that version — but only items whose open
--      step still exists on it (writing / design / the writer's review) or
--      that have not started. Items sitting at the manager's step right now
--      stay on their old version so the manager can finish them; finished
--      items stay too, because their approval is recorded on the OLD final
--      step key and re-pinning would make the release gate stop finding it.
--   3. Releases the capacity the planner booked for the manager's steps on
--      the re-pinned items.
--   4. Engine: a revision's skip list can never skip the FINAL step. Until
--      now the final step was the manager's and was never listed; a
--      caption-only revision lists design_writer_review, which IS the final
--      step now — without this it would end with no approval recorded and the
--      release gate would refuse the post forever.
--   5. content_revise / mos_content_request_caption hard-coded the manager's
--      step keys (`writing_review`, `design_review`). A revision now moves the
--      item onto its workflow's CURRENT version and reopens at a step that
--      exists there.

BEGIN;

-- ── 1. the paths ────────────────────────────────────────────────────────────
DO $paths$
DECLARE
  r record;
  v_final text;
  v_new   jsonb;
BEGIN
  FOR r IN SELECT id, metadata ->> 'key' AS wf_key, metadata FROM public.workflows
            WHERE kind = 'role_path' AND metadata ->> 'key' IN ('post_std', 'video_std')
  LOOP
    v_final := CASE r.wf_key WHEN 'post_std' THEN 'design_writer_review' ELSE 'writer_review' END;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r.metadata -> 'steps') s
                    WHERE s ->> 'key' = v_final AND (s ->> 'is_approval')::boolean) THEN
      RAISE EXCEPTION 'REMOVE_MGR_APPROVAL: % has no approval step %', r.wf_key, v_final;
    END IF;
    SELECT jsonb_agg(CASE WHEN e.s ->> 'key' = v_final
                          THEN e.s || jsonb_build_object('auto_meta_ad', true)
                          ELSE e.s - 'auto_meta_ad' END ORDER BY e.o)
      INTO v_new
      FROM jsonb_array_elements(r.metadata -> 'steps') WITH ORDINALITY e(s, o)
     WHERE e.s ->> 'role_key' IS DISTINCT FROM 'marketing_manager';
    UPDATE public.workflows SET metadata = jsonb_set(metadata, '{steps}', v_new) WHERE id = r.id;
  END LOOP;
END $paths$;

-- ── 2 + 3. re-pin in-flight work, release the manager's booked capacity ─────
DO $repin$
DECLARE
  v_wf     uuid;
  v_new    uuid;
  v_keys   text[];
  v_rows   uuid[];
  v_items  uuid[];
  n_rows int; n_items int; n_tasks int; n_res int;
BEGIN
  SELECT id INTO v_wf FROM public.workflows WHERE kind = 'role_path' AND metadata ->> 'key' = 'post_std';
  IF v_wf IS NULL THEN
    RAISE NOTICE 'REMOVE_MGR_APPROVAL: no post_std workflow — nothing to re-pin';
    RETURN;
  END IF;
  SELECT id INTO v_new FROM public.workflow_versions WHERE workflow_id = v_wf ORDER BY version_no DESC LIMIT 1;
  SELECT array_agg(s ->> 'key') INTO v_keys
    FROM public.workflow_versions v, LATERAL jsonb_array_elements(v.definition -> 'metadata' -> 'steps') s
   WHERE v.id = v_new;
  IF 'design_review' = ANY (v_keys) OR 'writing_review' = ANY (v_keys) THEN
    RAISE EXCEPTION 'REMOVE_MGR_APPROVAL: newest post_std version % still has a manager step', v_new;
  END IF;

  -- Rows: open task on a surviving step, or never started.
  SELECT array_agg(r.id) INTO v_rows
    FROM public.mos_content_rows r
    JOIN public.workflow_versions v ON v.id = r.workflow_version_id
   WHERE v.workflow_id = v_wf AND r.workflow_version_id <> v_new
     AND NOT EXISTS (SELECT 1 FROM public.mos_content c WHERE c.row_id = r.id AND c.archived_at IS NOT NULL)
     AND (EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                   WHERE t.subject_table = 'mos_content_rows' AND t.subject_id = r.id
                     AND t.status = 'open' AND t.step_key = ANY (v_keys))
          OR NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                          WHERE t.subject_table = 'mos_content_rows' AND t.subject_id = r.id));

  -- Single items: open task on a surviving step (or never started), not finished.
  SELECT array_agg(c.id) INTO v_items
    FROM public.mos_content c
    JOIN public.workflow_versions v ON v.id = c.workflow_version_id
   WHERE v.workflow_id = v_wf AND c.workflow_version_id <> v_new
     AND c.archived_at IS NULL
     AND (c.row_id = ANY (COALESCE(v_rows, '{}'))
          OR (c.row_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.mos_content_approvals a
                               WHERE a.content_id = c.id AND a.step_key = 'design_review')
              AND (EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                            WHERE t.subject_table = 'mos_content' AND t.subject_id = c.id
                              AND t.status = 'open' AND t.step_key = ANY (v_keys))
                   OR NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                                   WHERE t.subject_table = 'mos_content' AND t.subject_id = c.id))));

  UPDATE public.mos_content_rows SET workflow_version_id = v_new WHERE id = ANY (COALESCE(v_rows, '{}'));
  GET DIAGNOSTICS n_rows = ROW_COUNT;
  UPDATE public.mos_content SET workflow_version_id = v_new WHERE id = ANY (COALESCE(v_items, '{}'));
  GET DIAGNOSTICS n_items = ROW_COUNT;
  UPDATE public.workflow_role_tasks t SET workflow_version_id = v_new
   WHERE t.status = 'open'
     AND ((t.subject_table = 'mos_content_rows' AND t.subject_id = ANY (COALESCE(v_rows, '{}')))
       OR (t.subject_table = 'mos_content'      AND t.subject_id = ANY (COALESCE(v_items, '{}'))));
  GET DIAGNOSTICS n_tasks = ROW_COUNT;

  UPDATE public.mos_task_reservations res SET status = 'released', updated_at = now()
   WHERE res.role_key = 'marketing_manager'
     AND res.status IN ('reserved', 'bound', 'stale')
     AND res.superseded_at IS NULL
     AND (res.content_id = ANY (COALESCE(v_items, '{}')) OR res.row_id = ANY (COALESCE(v_rows, '{}')));
  GET DIAGNOSTICS n_res = ROW_COUNT;

  RAISE NOTICE 'REMOVE_MGR_APPROVAL: re-pinned % rows, % items, % open tasks to version %; released % manager reservations',
    n_rows, n_items, n_tasks, v_new, n_res;
END $repin$;

-- ── 4. engine: never skip the final step ────────────────────────────────────
-- Re-emitted from the LIVE definition with exactly one change, asserted.
DO $engine$
DECLARE
  v_def text := pg_get_functiondef('public.workflow_advance_role_path'::regproc);
  v_old text := $o$AND COALESCE(v_skip, '[]'::jsonb) @> jsonb_build_array(v_next ->> 'key') LOOP$o$;
  v_new text := $n$AND COALESCE(v_skip, '[]'::jsonb) @> jsonb_build_array(v_next ->> 'key')
              -- 2026-10-09: the final step (auto_meta_ad) is never skipped — it
              -- is where the approval is recorded. It used to be the manager's
              -- and never listed; now it is the writer's design review.
              AND NOT COALESCE((v_next ->> 'auto_meta_ad')::boolean, false) LOOP$n$;
  v_count int := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
BEGIN
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'REMOVE_MGR_APPROVAL: expected the skip loop once in workflow_advance_role_path, found %', v_count;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END $engine$;

-- ── 5a. content_revise: reopen on the CURRENT path ──────────────────────────
CREATE OR REPLACE FUNCTION public.content_revise(p_content_id uuid, p_scope text[], p_note text, p_event_id uuid DEFAULT NULL::uuid, p_request_hash text DEFAULT NULL::text, p_request_snapshot jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_c      public.mos_content%ROWTYPE;
  v_last   public.mos_content_approvals%ROWTYPE;
  v_scope  text[] := ARRAY[]::text[];
  v_next   text;
  v_round  int;
  v_actor  uuid := public.wassell_app_user_id(auth.uid());
  v_wh     text; v_dh text; v_ch text;
  v_ver    uuid; v_new uuid; v_step jsonb; v_replay jsonb; v_out jsonb;
BEGIN
  PERFORM public.mos_ledger_lock();
  IF NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'MOS:NOTE_REQUIRED' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.wassell_mos_can('revise_approved_content') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_replay := public.mos_completion_replay(p_event_id, 'content.revise', NULL, p_request_hash, v_actor);
  IF v_replay IS NOT NULL THEN RETURN v_replay; END IF;

  SELECT * INTO v_c FROM public.mos_content WHERE id = p_content_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:CONTENT_NOT_FOUND %', p_content_id USING ERRCODE = 'no_data_found';
  END IF;

  v_wh := public.mos_content_writing_hash(p_content_id);
  v_dh := public.mos_content_design_hash(p_content_id);
  v_ch := public.mos_caption_hash(v_c.data ->> 'caption');

  SELECT * INTO v_last FROM public.mos_content_approvals WHERE content_id = p_content_id ORDER BY approved_at DESC LIMIT 1;
  IF v_last.id IS NOT NULL THEN
    IF v_last.writing_hash IS DISTINCT FROM v_wh THEN v_scope := v_scope || 'writing'::text; END IF;
    IF v_last.design_hash  IS DISTINCT FROM v_dh THEN v_scope := v_scope || 'design'::text;  END IF;
    IF v_last.caption_hash IS DISTINCT FROM v_ch THEN v_scope := v_scope || 'caption'::text; END IF;
  END IF;
  IF p_scope IS NOT NULL THEN
    SELECT array_agg(DISTINCT s) INTO v_scope FROM unnest(COALESCE(v_scope, ARRAY[]::text[]) || p_scope) s WHERE s IS NOT NULL;
  END IF;
  IF COALESCE(array_length(v_scope, 1), 0) = 0 THEN v_scope := ARRAY['caption']; END IF;

  IF 'writing' = ANY (v_scope)
     AND EXISTS (SELECT 1 FROM public.mos_content_types ct
                  WHERE ct.id = v_c.content_type_id AND COALESCE(array_length(ct.design_fields,1),0) > 0)
     AND NOT ('design' = ANY (v_scope)) THEN
    v_scope := v_scope || 'design_affecting'::text;
  END IF;

  -- (2026-10-09) A revision is new work, so it runs on the workflow's CURRENT
  -- path, not the one the item was first pinned to. That is what keeps a
  -- removed step (the manager's approvals) from coming back on every revision
  -- of an older post. The release gate reads the final step off the pinned
  -- version, so the old approval stops counting and the new one, recorded at
  -- the end of this revision, is the one posted.
  SELECT (SELECT wv.id FROM public.workflow_versions wv
           WHERE wv.workflow_id = v.workflow_id ORDER BY wv.version_no DESC LIMIT 1)
    INTO v_ver
    FROM public.workflow_versions v WHERE v.id = v_c.workflow_version_id;
  v_ver := COALESCE(v_ver, v_c.workflow_version_id);

  v_next := CASE
    WHEN 'writing' = ANY (v_scope) OR 'design_affecting' = ANY (v_scope) OR 'caption' = ANY (v_scope) THEN 'writing_review'
    WHEN 'design' = ANY (v_scope) THEN 'design_writer_review'
    ELSE 'writing_review' END;
  -- No review of the writing on this path: the writer reopens the writing.
  IF v_next = 'writing_review' AND NOT EXISTS (
       SELECT 1 FROM public.workflow_versions v, LATERAL jsonb_array_elements(v.definition -> 'metadata' -> 'steps') e(elem)
        WHERE v.id = v_ver AND e.elem ->> 'key' = 'writing_review') THEN
    v_next := 'writing';
  END IF;

  IF 'caption' = ANY (v_scope) THEN
    UPDATE public.mos_content
       SET data = ((((data - 'caption_confirmed_text') - 'caption_confirmed_at') - 'caption_confirmed_hash') - 'caption_confirmed_by_writer_at')
     WHERE id = p_content_id;
  END IF;

  v_round := COALESCE((SELECT max(round) FROM public.workflow_role_tasks
                        WHERE subject_table = 'mos_content' AND subject_id = p_content_id), 0) + 1;

  UPDATE public.mos_content
     SET data = data || jsonb_build_object('revision', jsonb_build_object(
                  'round', v_round, 'scope', to_jsonb(v_scope), 'note', p_note, 'opened_at', now(),
                  'skip_steps', CASE WHEN v_scope = ARRAY['caption'] THEN jsonb_build_array('design','design_writer_review') ELSE '[]'::jsonb END)),
         on_hold_at = NULL, rejected_at = NULL,
         workflow_version_id = v_ver
   WHERE id = p_content_id;

  INSERT INTO public.mos_content_events (content_id, kind, actor_user_id, detail)
  VALUES (p_content_id, 'revision_opened', v_actor,
          jsonb_build_object('scope', to_jsonb(v_scope), 'note', p_note, 'round', v_round,
                             'writing_hash', v_wh, 'design_hash', v_dh, 'caption_hash', v_ch));

  SELECT t.id INTO v_new FROM public.workflow_role_tasks t
   WHERE t.subject_table = 'mos_content' AND t.subject_id = p_content_id
     AND t.status = 'open' AND t.step_key = v_next AND t.round = v_round LIMIT 1;

  IF v_new IS NULL THEN
    UPDATE public.workflow_role_tasks
       SET status = 'done', result = 'changes_requested', note = p_note,
           closed_at = now(), closed_by_user_id = v_actor, offered_to_user_id = NULL, offered_at = NULL
     WHERE subject_table = 'mos_content' AND subject_id = p_content_id AND status = 'open';

    SELECT e.elem INTO v_step
      FROM public.workflow_versions v, LATERAL jsonb_array_elements(v.definition -> 'metadata' -> 'steps') e(elem)
     WHERE v.id = v_ver AND e.elem ->> 'key' = v_next LIMIT 1;
    IF v_step IS NOT NULL THEN
      v_new := public.mos_task_open_step('mos_content', p_content_id, v_ver, v_step, v_round);
    END IF;
  END IF;

  v_out := jsonb_build_object('scope', to_jsonb(v_scope), 'next_step', v_next, 'round', v_round,
                              'opened_task_id', v_new, 'event_id', p_event_id);
  IF p_event_id IS NOT NULL THEN
    INSERT INTO public.mos_completion_events
      (event_id, operation, task_id, subject_table, subject_id, actor_user_id, request_hash, request_snapshot, outcome)
    VALUES (p_event_id, 'content.revise', NULL, 'mos_content', p_content_id, v_actor,
            COALESCE(p_request_hash, ''), COALESCE(p_request_snapshot, '{}'::jsonb), v_out);
  END IF;
  IF v_step IS NOT NULL THEN PERFORM public.mos_refill_request(ARRAY[v_step ->> 'role_key']); END IF;
  RETURN v_out;
END $function$;

-- ── 5b. mos_content_request_caption: "finally approved" by flag, current path ─
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
  -- work, not a way to skip the design of unfinished work. The final step is
  -- the one its pinned path flags `auto_meta_ad` (2026-10-09 — it was always
  -- `design_review` while that step was the manager's).
  IF NOT EXISTS (SELECT 1 FROM public.workflow_role_tasks t
                  WHERE t.subject_table = 'mos_content' AND t.subject_id = p_content_id
                    AND t.result = 'approved'
                    AND (t.step_key = 'design_review'
                         OR t.step_key IN (SELECT e.elem ->> 'key'
                                             FROM public.workflow_versions v,
                                                  LATERAL jsonb_array_elements(v.definition -> 'metadata' -> 'steps') e(elem)
                                            WHERE v.id = v_c.workflow_version_id
                                              AND COALESCE((e.elem ->> 'auto_meta_ad')::boolean, false)))) THEN
    RAISE EXCEPTION 'MOS:NOT_FINALLY_APPROVED %', v_c.ref USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The new round runs on the workflow's CURRENT path (see content_revise).
  SELECT (SELECT wv.id FROM public.workflow_versions wv
           WHERE wv.workflow_id = v.workflow_id ORDER BY wv.version_no DESC LIMIT 1)
    INTO v_ver
    FROM public.workflow_versions v WHERE v.id = v_c.workflow_version_id;
  v_ver := COALESCE(v_ver, v_c.workflow_version_id);
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
         on_hold_at = NULL, rejected_at = NULL,
         workflow_version_id = v_ver
   WHERE id = p_content_id;

  INSERT INTO public.mos_content_events (content_id, kind, actor_user_id, detail)
  VALUES (p_content_id, 'revision_opened', NULL,
          jsonb_build_object('scope', jsonb_build_array('caption'), 'note', p_note, 'round', v_round,
                             'reason', 'caption_request'));

  v_new := public.mos_task_open_step('mos_content', p_content_id, v_ver, v_step, v_round);
  PERFORM public.mos_refill_request(ARRAY[v_step ->> 'role_key']);
  RETURN jsonb_build_object('content_id', p_content_id, 'ref', v_c.ref, 'round', v_round, 'opened_task_id', v_new);
END $function$;

-- ── assertions ──────────────────────────────────────────────────────────────
DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM public.workflows w, LATERAL jsonb_array_elements(w.metadata -> 'steps') s
              WHERE w.kind = 'role_path' AND w.metadata ->> 'key' IN ('post_std', 'video_std')
                AND s ->> 'role_key' = 'marketing_manager') THEN
    RAISE EXCEPTION 'REMOVE_MGR_APPROVAL: a content path still has a manager step';
  END IF;
  IF EXISTS (SELECT 1 FROM public.workflows w
              WHERE w.kind = 'role_path' AND w.metadata ->> 'key' IN ('post_std', 'video_std')
                AND (SELECT count(*) FROM jsonb_array_elements(w.metadata -> 'steps') s
                      WHERE COALESCE((s ->> 'auto_meta_ad')::boolean, false)) <> 1) THEN
    RAISE EXCEPTION 'REMOVE_MGR_APPROVAL: a content path does not have exactly one final (auto_meta_ad) step';
  END IF;
  IF strpos(pg_get_functiondef('public.workflow_advance_role_path'::regproc), '(v_next ->> ''auto_meta_ad'')') = 0 THEN
    RAISE EXCEPTION 'REMOVE_MGR_APPROVAL: engine skip guard missing';
  END IF;
END $assert$;

COMMIT;
