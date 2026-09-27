-- ============================================================================
-- Publishing is not a task — 2026-09-27.
--
-- The operator: «I DON'T WANT ANY PUBLISHING TASKS, PUBLISHING TASKS DOES NOT
-- COUNT AS REAL TASKS». Until now every release the system could not publish by
-- itself became a manual «نشر — …» task on the release owner (the writer), was
-- charged as 0.5 of her PRODUCTION capacity per task, and — once past its time —
-- became a lateness strike with a one-day deduction. On the day this was written
-- that was 12 open publish tasks (6 units of مريم's writing day) and 18 strikes,
-- all hers, all pending (discipline is in observe mode, so none could be applied).
--
--   1. mos_settings.planning.publish_tasks_enabled = false. mos_release_open_task
--      is the ONLY creator of kind='publish' tasks (the release sweep,
--      publishRelease, releaseMaterial and releaseActions all call it), so one
--      gate stops every path. Absent or anything but exactly true = off.
--   2. release_effort_days = 0 — the planner books publishing load only when a
--      release has effort (releases.ts buildReleases), so plans stop charging it.
--   3. mos_work_ledger_v — a publish task never counts as load, even if the
--      setting is turned back on.
--   4. mos_perf_late_sweep — a publish task can never become a lateness strike.
--   5. Data: open publish tasks are cancelled; the strikes publish tasks produced
--      are copied to _backup_publish_late_events_20260927 (RLS on, no grants),
--      their pending deductions are rejected, and they leave the counter.
--
-- The three objects are re-emitted from their LIVE definitions with only the
-- publish exclusion added. mos_work_ledger_v had no reloptions (not
-- security_invoker) and has no dependents, so CREATE OR REPLACE loses nothing.
-- Re-runnable. No SQLSTATE 40001/40P01 anywhere.
-- ============================================================================

BEGIN;

-- 1 + 2 ─ the switches
UPDATE public.mos_settings
   SET value = value || jsonb_build_object('publish_tasks_enabled', false, 'release_effort_days', 0)
 WHERE key = 'planning';

-- 1 ─ the only creator of publish tasks opens nothing while they are off
CREATE OR REPLACE FUNCTION public.mos_release_open_task(p_publication_id uuid, p_reason text, p_detail text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rel      record;
  v_existing uuid;
  v_owner    uuid;
  v_role     text := COALESCE(public.mos_planning_cfg() ->> 'release_owner_role', 'mos_writer');
  v_id       uuid;
  v_title    text;
BEGIN
  -- Publishing is not a task (2026-09-27). Off unless the setting says exactly
  -- true: no publish task is opened, by any caller. NULL is the function's own
  -- "nothing to open" answer, which every caller already handles.
  IF COALESCE(public.mos_planning_cfg() ->> 'publish_tasks_enabled', 'false') <> 'true' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_rel FROM public.mos_release_v WHERE release_id = p_publication_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:RELEASE_NOT_FOUND %', p_publication_id USING ERRCODE = 'no_data_found';
  END IF;

  SELECT id INTO v_existing FROM public.mos_manual_tasks
   WHERE kind = 'publish' AND ref_id = p_publication_id AND status = 'open' LIMIT 1;
  IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;

  IF v_rel.status IN ('published','cancelled') THEN RETURN NULL; END IF;

  -- 1. whoever holds the configured release role, most publishing headroom first
  SELECT u.id INTO v_owner
    FROM public.users u
    JOIN public.roles r
      ON r.key = v_role
     AND r.id::text IN (SELECT e ->> 'role_id'
                          FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
   WHERE u.is_active
   ORDER BY public.mos_user_daily_slots(u.id, 'publishing') DESC, u.id
   LIMIT 1;

  -- 2. the marketing manager, who can always reassign it
  IF v_owner IS NULL THEN
    SELECT u.id INTO v_owner
      FROM public.users u
      JOIN public.roles r
        ON r.key = 'mos_marketing_manager'
       AND r.id::text IN (SELECT e ->> 'role_id'
                            FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
     WHERE u.is_active
     ORDER BY u.id
     LIMIT 1;
  END IF;

  -- 3. anyone who works in marketing at all
  IF v_owner IS NULL THEN
    SELECT u.id INTO v_owner
      FROM public.users u
      JOIN public.roles r
        ON r.key LIKE 'mos\_%' ESCAPE '\'
       AND r.id::text IN (SELECT e ->> 'role_id'
                            FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e)
     WHERE u.is_active
     ORDER BY u.id
     LIMIT 1;
  END IF;

  -- Nobody at all. Say so in the log instead of returning a quiet NULL that
  -- reads like "nothing to do": this release cannot go out and no one knows.
  IF v_owner IS NULL THEN
    RAISE WARNING 'MOS:RELEASE_UNASSIGNABLE % (%) — no active marketing user to own it', p_publication_id, p_reason;
    RETURN NULL;
  END IF;

  v_title := 'نشر — ' || COALESCE(v_rel.content_title, v_rel.content_ref, '') ||
             ' · ' || v_rel.platform;

  INSERT INTO public.mos_manual_tasks
    (title, details, assignee_user_id, created_by_user_id, campaign_id, content_id, project_id,
     status, due_at, kind, ref_id, entity_kind, entity_id, action)
  VALUES (
    left(v_title, 200),
    COALESCE(p_detail, CASE p_reason
      WHEN 'account_not_connected'    THEN 'الحساب غير موصول أو لا يملك صلاحية النشر — انشر يدويًا ثم ألصق الرابط.'
      WHEN 'platform_not_automatable' THEN 'هذه المنصة بلا ربط نشر — انشر يدويًا ثم ألصق الرابط.'
      WHEN 'manual_by_policy'         THEN 'النشر على هذه المنصة يدوي بقرار التشغيل.'
      WHEN 'preflight_blocked'        THEN 'متطلبات المنصة غير مستوفاة — عالجها ثم انشر.'
      WHEN 'publish_failed'           THEN 'فشل النشر الآلي — راجع السبب ثم أعد المحاولة.'
      ELSE 'يحتاج النشر إلى تدخل يدوي.' END),
    v_owner, v_owner, v_rel.campaign_id, v_rel.content_id, v_rel.project_id,
    'open', v_rel.due_at, 'publish', p_publication_id, 'publication', p_publication_id, p_reason)
  RETURNING id INTO v_id;

  RETURN v_id;
END $function$;

-- 3 ─ a publish task is never load
CREATE OR REPLACE VIEW public.mos_work_ledger_v AS
SELECT t.assignee_user_id AS user_id,
    s.day,
    mos_ledger_bucket(t.workflow_version_id, t.step_key, COALESCE(t.bucket, mos_subject_bucket(t.subject_table, t.subject_id))) AS bucket,
    s.weight,
    'task'::text AS source,
    t.id AS ref_id
   FROM workflow_role_tasks t
     CROSS JOIN LATERAL mos_spread_effort(GREATEST(COALESCE(t.scheduled_start, mos_perf_today()), mos_perf_today()), GREATEST(COALESCE(t.effort_days, mos_step_effort_days(mos_workflow_key_of(t.subject_id), t.step_key, mos_ledger_bucket(t.workflow_version_id, t.step_key, COALESCE(t.bucket, mos_perf_bucket_of(t.subject_id))))) - COALESCE(t.progress_days, 0::numeric), 0.5)) s(day, weight)
  WHERE t.status = 'open'::text AND t.subject_table = 'mos_content'::text AND t.assignee_user_id IS NOT NULL
UNION ALL
 SELECT t.assignee_user_id AS user_id,
    s.day,
    mos_ledger_bucket(t.workflow_version_id, t.step_key, COALESCE(t.bucket, mos_subject_bucket(t.subject_table, t.subject_id))) AS bucket,
    s.weight,
    'task'::text AS source,
    t.id AS ref_id
   FROM workflow_role_tasks t
     CROSS JOIN LATERAL mos_spread_effort_same_day(GREATEST(COALESCE(t.scheduled_start, mos_perf_today()), mos_perf_today()), GREATEST(COALESCE(t.effort_days, GREATEST(( SELECT count(*) AS count
           FROM mos_content c
          WHERE c.row_id = t.subject_id), 1::bigint)::numeric * mos_step_effort_days(mos_subject_workflow_key(t.subject_table, t.subject_id), t.step_key, mos_ledger_bucket(t.workflow_version_id, t.step_key, COALESCE(t.bucket, mos_subject_bucket(t.subject_table, t.subject_id))))) - COALESCE(t.progress_days, 0::numeric), 0.5)) s(day, weight)
  WHERE t.status = 'open'::text AND t.subject_table = 'mos_content_rows'::text AND t.assignee_user_id IS NOT NULL
UNION ALL
 SELECT r.assignee_user_id AS user_id,
    s.day,
    r.bucket,
    s.weight,
    'reservation'::text AS source,
    r.id AS ref_id
   FROM mos_task_reservations r
     CROSS JOIN LATERAL mos_spread_effort_mode(GREATEST(r.planned_start, mos_perf_today()), r.weight, r.row_id IS NOT NULL) s(day, weight)
  WHERE (r.status = ANY (ARRAY['reserved'::text, 'bound'::text])) AND r.planned_end >= mos_perf_today() AND r.assignee_user_id IS NOT NULL
UNION ALL
 SELECT r.assignee_user_id AS user_id,
    s.day,
    r.bucket,
    s.weight,
    'reservation'::text AS source,
    r.id AS ref_id
   FROM mos_task_reservations r
     CROSS JOIN LATERAL mos_spread_effort_mode(mos_perf_today(), r.weight, r.row_id IS NOT NULL) s(day, weight)
  WHERE (r.status = 'stale'::text OR (r.status = ANY (ARRAY['reserved'::text, 'bound'::text])) AND r.planned_end < mos_perf_today()) AND r.assignee_user_id IS NOT NULL
UNION ALL
 SELECT m.assignee_user_id AS user_id,
    GREATEST(COALESCE((m.due_at AT TIME ZONE 'Asia/Riyadh'::text)::date, mos_perf_today()), mos_perf_today()) AS day,
    mos_manual_task_bucket(m.assignee_user_id) AS bucket,
    COALESCE((mos_planning_cfg() ->> 'manual_task_weight'::text)::numeric, 0.5) AS weight,
    'manual'::text AS source,
    m.id AS ref_id
   FROM mos_manual_tasks m
  WHERE m.status = 'open'::text AND m.assignee_user_id IS NOT NULL AND m.kind IS DISTINCT FROM 'publish'::text;

-- 4 ─ a publish task is never a lateness strike
CREATE OR REPLACE FUNCTION public.mos_perf_late_sweep()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_month   text := public.mos_perf_month_key();
  v_new     int := 0;
  v_actions int := 0;
  rec       record;
  v_event   uuid;
  v_ordinal int;
BEGIN
  FOR rec IN
    SELECT 'workflow' AS task_source, t.id, t.assignee_user_id AS user_id, t.subject_id AS content_id
      FROM public.workflow_role_tasks t
     WHERE t.status = 'open' AND NOT t.blocked AND NOT t.late_flag
       AND t.due_at IS NOT NULL AND t.due_at < now()
       AND t.assignee_user_id IS NOT NULL
       AND (t.subject_table <> 'mos_content'
            OR EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = t.subject_id))
    UNION ALL
    SELECT 'manual', m.id, m.assignee_user_id, m.content_id
      FROM public.mos_manual_tasks m
     WHERE m.status = 'open' AND NOT m.blocked AND NOT m.late_flag
       AND m.due_at IS NOT NULL AND m.due_at < now()
       AND m.assignee_user_id IS NOT NULL
       -- Publishing is not a task (2026-09-27): it can never become a lateness strike.
       AND m.kind IS DISTINCT FROM 'publish'
  LOOP
    CONTINUE WHEN public.mos_perf_on_leave_now(rec.user_id);

    IF rec.task_source = 'workflow' THEN
      UPDATE public.workflow_role_tasks SET late_flag = true WHERE id = rec.id;
    ELSE
      UPDATE public.mos_manual_tasks SET late_flag = true WHERE id = rec.id;
    END IF;

    INSERT INTO public.mos_late_events (user_id, task_source, task_id, content_id, month_key)
    VALUES (rec.user_id, rec.task_source, rec.id, rec.content_id, v_month)
    ON CONFLICT (task_id) DO NOTHING
    RETURNING id INTO v_event;
    CONTINUE WHEN v_event IS NULL;
    v_new := v_new + 1;

    SELECT count(*) INTO v_ordinal FROM public.mos_late_events
     WHERE user_id = rec.user_id AND month_key = v_month;

    INSERT INTO public.mos_discipline_actions
      (user_id, month_key, ordinal, kind, amount_days, late_event_id)
    VALUES
      (rec.user_id, v_month, v_ordinal,
       CASE WHEN v_ordinal >= 4 THEN 'deduction' ELSE 'warning' END,
       CASE WHEN v_ordinal >= 4 THEN 1.0 ELSE NULL END,
       v_event)
    ON CONFLICT (late_event_id) DO NOTHING;
    v_actions := v_actions + 1;

    PERFORM public.notify_emit(
      'marketing', 'task_late', ARRAY[]::text[], ARRAY[rec.user_id],
      'مهمة متأخرة', 'A task passed its deadline',
      'مهمة تجاوزت موعدها ولا تزال مفتوحة — أنجزها بأسرع وقت.', 'An open task passed its due date.',
      CASE WHEN rec.content_id IS NOT NULL THEN '/m/content/' || rec.content_id ELSE '/m/my-work' END,
      NULL);
  END LOOP;

  RETURN jsonb_build_object('month', v_month, 'new_late_events', v_new, 'actions', v_actions);
END $function$;

-- 5 ─ the data the old behaviour left behind
UPDATE public.mos_manual_tasks
   SET status = 'cancelled', late_flag = false, closed_at = now(), updated_at = now(),
       done_note = 'publishing is not a task (operator rule 2026-09-27)'
 WHERE kind = 'publish' AND status = 'open';

CREATE TABLE IF NOT EXISTS public._backup_publish_late_events_20260927
  (LIKE public.mos_late_events INCLUDING DEFAULTS);
ALTER TABLE public._backup_publish_late_events_20260927 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._backup_publish_late_events_20260927 FROM anon, authenticated;
INSERT INTO public._backup_publish_late_events_20260927
SELECT le.* FROM public.mos_late_events le
 WHERE le.task_source = 'manual'
   AND le.task_id IN (SELECT id FROM public.mos_manual_tasks WHERE kind = 'publish')
   AND NOT EXISTS (SELECT 1 FROM public._backup_publish_late_events_20260927 b WHERE b.id = le.id);

UPDATE public.mos_discipline_actions da
   SET status = 'rejected', decided_at = now(),
       dispute_note = coalesce(da.dispute_note || ' · ', '') || 'publishing is not a task (operator rule 2026-09-27)'
 WHERE da.status IN ('pending', 'disputed')
   AND da.late_event_id IN (
     SELECT le.id FROM public.mos_late_events le
      WHERE le.task_source = 'manual'
        AND le.task_id IN (SELECT id FROM public.mos_manual_tasks WHERE kind = 'publish'));

DELETE FROM public.mos_late_events le
 WHERE le.task_source = 'manual'
   AND le.task_id IN (SELECT id FROM public.mos_manual_tasks WHERE kind = 'publish');

-- ─ post-conditions (guarded: an empty database passes trivially)
DO $assert$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.mos_manual_tasks WHERE kind = 'publish' AND status = 'open';
  IF n <> 0 THEN RAISE EXCEPTION 'PUBLISH_TASKS_STILL_OPEN %', n; END IF;
  SELECT count(*) INTO n FROM public.mos_late_events le
   WHERE le.task_source = 'manual' AND le.task_id IN (SELECT id FROM public.mos_manual_tasks WHERE kind = 'publish');
  IF n <> 0 THEN RAISE EXCEPTION 'PUBLISH_STRIKES_STILL_COUNTED %', n; END IF;
  SELECT count(*) INTO n FROM public.mos_work_ledger_v l JOIN public.mos_manual_tasks m ON l.source = 'manual' AND m.id = l.ref_id
   WHERE m.kind = 'publish';
  IF n <> 0 THEN RAISE EXCEPTION 'PUBLISH_TASKS_STILL_LOAD %', n; END IF;
  IF EXISTS (SELECT 1 FROM public.mos_settings WHERE key = 'planning')
     AND (SELECT value ->> 'publish_tasks_enabled' FROM public.mos_settings WHERE key = 'planning') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'PUBLISH_SWITCH_NOT_OFF';
  END IF;
END $assert$;

COMMIT;
