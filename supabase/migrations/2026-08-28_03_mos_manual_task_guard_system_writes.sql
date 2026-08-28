-- The manual-task column guard exists to stop a browser-JWT ASSIGNEE from
-- editing their way out of a task. A writer with NO auth.uid() is not a
-- browser session — it is service_role / SQL (the perf late sweep, crons),
-- which bypasses RLS anyway; the guard blocking it broke mos_perf_late_sweep
-- (MOS:TASK_NOT_YOURS on the late_flag UPDATE, caught live 2026-08-28).
-- Verbatim re-emit of the live definition + the one system-write bypass at
-- the top.
CREATE OR REPLACE FUNCTION public.mos_tg_manual_task_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me uuid := public.wassell_app_user_id(auth.uid());
BEGIN
  -- System writes (service_role, SQL, cron sweeps) carry no auth.uid(); the
  -- guard's threat model is browser assignees only.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF public.wassell_mos_can('assign_task') OR OLD.created_by_user_id = v_me THEN
    RETURN NEW;
  END IF;

  IF OLD.assignee_user_id IS DISTINCT FROM v_me THEN
    RAISE EXCEPTION 'MOS:TASK_NOT_YOURS';
  END IF;

  IF NEW.title              IS DISTINCT FROM OLD.title
     OR NEW.details            IS DISTINCT FROM OLD.details
     OR NEW.assignee_user_id   IS DISTINCT FROM OLD.assignee_user_id
     OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
     OR NEW.due_at             IS DISTINCT FROM OLD.due_at
     OR NEW.campaign_id        IS DISTINCT FROM OLD.campaign_id
     OR NEW.content_id         IS DISTINCT FROM OLD.content_id
     OR NEW.goal_id            IS DISTINCT FROM OLD.goal_id
     OR NEW.project_id         IS DISTINCT FROM OLD.project_id
     OR NEW.series_id          IS DISTINCT FROM OLD.series_id
     OR NEW.occurrence_on      IS DISTINCT FROM OLD.occurrence_on
  THEN
    RAISE EXCEPTION 'MOS:TASK_FIELD_LOCKED';
  END IF;

  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' THEN
    RAISE EXCEPTION 'MOS:TASK_CANCEL_DENIED';
  END IF;

  RETURN NEW;
END;
$function$;
