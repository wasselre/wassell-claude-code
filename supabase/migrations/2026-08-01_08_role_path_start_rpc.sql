-- ============================================================================
-- workflow_role_path_start — open a subject's FIRST role-path task with
-- definer rights.
--
-- Design screen 33 grants «إنشاء محتوى» to Writer and Ops Supervisor, but the
-- workflow_role_tasks INSERT policy requires the broad 'assign' capability —
-- so a Writer could create the content row and then 403 on opening its first
-- task (found live by the fixture build, 2026-08-01). Task-opening on create
-- is an ENGINE concern: this RPC validates the caller's creation right and
-- opens round-1/step-1 from the PINNED version, atomically and idempotently.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.workflow_role_path_start(
  p_subject_table text,
  p_subject_id    uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_steps  jsonb;
  v_first  jsonb;
  v_ver    uuid;
  v_new_id uuid;
BEGIN
  IF p_subject_table <> 'mos_content' THEN
    RAISE EXCEPTION 'MOS:UNSUPPORTED_SUBJECT %', p_subject_table
      USING ERRCODE = 'feature_not_supported';
  END IF;

  -- The creation right, not the assignment right.
  IF NOT public.wassell_mos_can('write_content') THEN
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

  RETURN jsonb_build_object('opened_task_id', v_new_id, 'already_open', false);
END $function$;

GRANT EXECUTE ON FUNCTION public.workflow_role_path_start(text, uuid) TO authenticated;

COMMIT;
