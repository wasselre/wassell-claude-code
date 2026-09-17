-- ============================================================================
-- Work started by the sweep tells its new owner. 2026-09-17.
--
-- mos_plan_start_due opens the first step through workflow_role_path_start,
-- which hands out inline WITHOUT a notification (inline hand-outs inside a
-- person's own action are notified by the API). The sweep's new starts had no
-- API around them, so the writer received work silently — found live right
-- after part 2 landed: three writing tasks assigned, zero notifications.
--
-- Fix: one notifier, mos_task_notify_assigned, used by the dispatcher and by
-- the start loop for the task each start opened.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_task_notify_assigned(p_task_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_task  public.workflow_role_tasks%ROWTYPE;
  v_label text;
BEGIN
  SELECT * INTO v_task FROM public.workflow_role_tasks WHERE id = p_task_id;
  IF NOT FOUND OR v_task.status <> 'open' OR v_task.assignee_user_id IS NULL THEN RETURN; END IF;
  v_label := COALESCE(
    (SELECT COALESCE(NULLIF(btrim(c.title), ''), c.ref) FROM public.mos_content c
      WHERE v_task.subject_table = 'mos_content' AND c.id = v_task.subject_id),
    (SELECT string_agg(COALESCE(NULLIF(btrim(c.title), ''), c.ref), ' · ' ORDER BY c.row_order NULLS LAST)
       FROM public.mos_content c
      WHERE v_task.subject_table = 'mos_content_rows' AND c.row_id = v_task.subject_id
        AND c.archived_at IS NULL),
    '');
  -- A failed notification must not undo the hand-out: logged loudly, it stands.
  BEGIN
    PERFORM public.notify_emit('marketing', 'task_assigned', ARRAY[]::text[], ARRAY[v_task.assignee_user_id],
      'فُتحت لك مهمة', 'A task was assigned to you',
      format('«%s» بانتظار خطوتك.', v_label), v_label, '/m/my-work', NULL);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'MOS:DISPATCH_NOTIFY_FAILED task % user %: % %',
      p_task_id, v_task.assignee_user_id, SQLSTATE, SQLERRM;
  END;
END $$;

DO $migrate$
DECLARE
  v_def text;
  v_old text;
  v_new text;
BEGIN
  -- (1) the dispatcher's inline notify block → the shared notifier
  v_def := pg_get_functiondef('public.mos_task_dispatch(uuid, boolean)'::regprocedure);
  v_old := substring(v_def FROM '  IF p_notify THEN.*?\n  END IF;\n\n  RETURN ''assigned'';');
  IF v_old IS NULL THEN
    RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING mos_task_dispatch notify block';
  END IF;
  v_new := E'  IF p_notify THEN\n    PERFORM public.mos_task_notify_assigned(p_task_id);\n  END IF;\n\n  RETURN ''assigned'';';
  EXECUTE replace(v_def, v_old, v_new);

  -- (2) the start loop notifies the task each start opened
  v_def := pg_get_functiondef('public.mos_plan_start_due()'::regprocedure);
  v_old := E'    PERFORM public.workflow_role_path_start(r.st, r.id);\n';
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING mos_plan_start_due path_start call';
  END IF;
  v_new := E'    PERFORM public.mos_task_notify_assigned(\n'
        || E'      ((public.workflow_role_path_start(r.st, r.id)) ->> ''opened_task_id'')::uuid);\n';
  EXECUTE replace(v_def, v_old, v_new);
END $migrate$;

REVOKE ALL ON FUNCTION public.mos_task_notify_assigned(uuid) FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF pg_get_functiondef('public.mos_plan_start_due()'::regprocedure) NOT LIKE '%mos_task_notify_assigned%'
     OR pg_get_functiondef('public.mos_task_dispatch(uuid, boolean)'::regprocedure) NOT LIKE '%mos_task_notify_assigned%' THEN
    RAISE EXCEPTION 'MOS:NOTIFY_REWIRE_FAILED';
  END IF;
  IF has_function_privilege('anon', 'public.mos_task_notify_assigned(uuid)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'MOS:ANON_CAN_EXECUTE mos_task_notify_assigned';
  END IF;
END $$;

COMMIT;
