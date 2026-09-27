-- ============================================================================
-- Team KPIs: "open now" split into today and coming days — 2026-09-27.
--
-- The operator, on the «الفريق» tab: «Didn't we say Sara will have only 7
-- tasks? … Then why is it showing me 12?». The cell «مفتوحة الآن» counted every
-- task she HOLDS — today's five (the late 22 Sep batch, three posts, plus four
-- designs = her 7-a-day limit) and seven more she already held for Monday and
-- Tuesday. It counted tasks, not designs, and not per day, so the page never
-- showed the number the operator set.
--
-- mos_team_kpis_core now also returns, per person and for the team:
--   open_today — open tasks whose plan day (scheduled_start; for a hand-assigned
--                task its due date) is today or earlier — overdue work included;
--   open_later — open tasks already held for a coming day.
-- open_today + open_later = open_now, asserted below. The page shows today's
-- booked work against the daily limit («اليوم ٧ من ٧», from the strip's first
-- day) and these two counts under it.
--
-- Re-emitted from the applied definition (2026-09-27_02) with only the plan_day
-- column and the two counts added. CREATE OR REPLACE keeps the function's
-- owner and grants. Read-only. No SQLSTATE 40001/40P01. Re-runnable.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_team_kpis_core(p_period text DEFAULT 'month')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_period  text := CASE WHEN p_period = 'week' THEN 'week' ELSE 'month' END;
  v_today   date := public.mos_perf_today();
  v_from    date;
  v_from_ts timestamptz;
  v_to_ts   timestamptz;
  v_out     jsonb;
BEGIN
  v_from := CASE WHEN v_period = 'week' THEN v_today - 6
                 ELSE v_today - (EXTRACT(DAY FROM v_today)::int - 1) END;
  v_from_ts := v_from::timestamp AT TIME ZONE 'Asia/Riyadh';
  v_to_ts   := (v_today + 1)::timestamp AT TIME ZONE 'Asia/Riyadh';

  WITH tasks AS (
    -- Workflow tasks: open now (on content that still exists — the late
    -- sweep's own test), or finished inside the period.
    SELECT t.assignee_user_id AS uid, t.status, t.due_at, t.closed_at, t.blocked, t.late_flag,
           COALESCE(t.assigned_at, t.opened_at, t.created_at) AS start_at,
           -- The plan's day for the task — the same day mos_work_ledger_v books it.
           COALESCE(t.scheduled_start, v_today) AS plan_day
      FROM public.workflow_role_tasks t
     WHERE t.assignee_user_id IS NOT NULL
       AND ((t.status = 'open'
             AND (t.subject_table <> 'mos_content'
                  OR EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = t.subject_id)))
         OR (t.status = 'done' AND t.closed_at >= v_from_ts AND t.closed_at < v_to_ts))
    UNION ALL
    -- Hand-assigned tasks. Publishing is not a task.
    SELECT m.assignee_user_id, m.status, m.due_at, m.closed_at, m.blocked, m.late_flag, m.created_at,
           COALESCE((m.due_at AT TIME ZONE 'Asia/Riyadh')::date, v_today)
      FROM public.mos_manual_tasks m
     WHERE m.assignee_user_id IS NOT NULL
       AND m.kind IS DISTINCT FROM 'publish'
       AND (m.status = 'open'
         OR (m.status = 'done' AND m.closed_at >= v_from_ts AND m.closed_at < v_to_ts))
  ),
  per AS (
    SELECT uid,
           count(*) FILTER (WHERE status = 'open') AS open_now,
           count(*) FILTER (WHERE status = 'open' AND plan_day <= v_today) AS open_today,
           count(*) FILTER (WHERE status = 'open' AND plan_day > v_today) AS open_later,
           count(*) FILTER (WHERE status = 'open' AND NOT blocked AND due_at < now()) AS late_now,
           count(*) FILTER (WHERE status = 'open' AND blocked) AS blocked_now,
           count(*) FILTER (WHERE status = 'open' AND NOT blocked AND due_at >= now()
                              AND (due_at AT TIME ZONE 'Asia/Riyadh')::date = v_today) AS due_today,
           count(*) FILTER (WHERE status = 'done') AS done,
           count(*) FILTER (WHERE status = 'done' AND (late_flag OR closed_at > due_at)) AS done_late,
           count(*) FILTER (WHERE status = 'done' AND due_at IS NULL AND NOT late_flag) AS done_no_deadline,
           round((percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY (EXTRACT(EPOCH FROM (closed_at - start_at)) / 3600)::float8)
                  FILTER (WHERE status = 'done' AND closed_at >= start_at))::numeric, 1) AS median_hours
      FROM tasks
     GROUP BY uid
  ),
  team AS (
    SELECT count(*) FILTER (WHERE status = 'open') AS open_now,
           count(*) FILTER (WHERE status = 'open' AND plan_day <= v_today) AS open_today,
           count(*) FILTER (WHERE status = 'open' AND plan_day > v_today) AS open_later,
           count(*) FILTER (WHERE status = 'open' AND NOT blocked AND due_at < now()) AS late_now,
           count(*) FILTER (WHERE status = 'open' AND blocked) AS blocked_now,
           count(*) FILTER (WHERE status = 'open' AND NOT blocked AND due_at >= now()
                              AND (due_at AT TIME ZONE 'Asia/Riyadh')::date = v_today) AS due_today,
           count(*) FILTER (WHERE status = 'done') AS done,
           count(*) FILTER (WHERE status = 'done' AND (late_flag OR closed_at > due_at)) AS done_late,
           count(*) FILTER (WHERE status = 'done' AND due_at IS NULL AND NOT late_flag) AS done_no_deadline,
           round((percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY (EXTRACT(EPOCH FROM (closed_at - start_at)) / 3600)::float8)
                  FILTER (WHERE status = 'done' AND closed_at >= start_at))::numeric, 1) AS median_hours
      FROM tasks
  ),
  stk AS (
    SELECT le.user_id AS uid, count(*) AS n
      FROM public.mos_late_events le
     WHERE le.created_at >= v_from_ts AND le.created_at < v_to_ts
     GROUP BY 1
  ),
  lv AS MATERIALIZED (
    SELECT l.user_id AS uid, l.day, l.bucket, l.weight, l.source || ':' || l.ref_id::text AS item
      FROM public.mos_work_ledger_v l
     WHERE l.day >= v_today AND l.day < v_today + 30
  ),
  led AS (
    SELECT uid, day, bucket, sum(weight) AS units FROM lv GROUP BY 1, 2, 3
  ),
  bk AS (
    SELECT uid, count(DISTINCT item) AS items, sum(weight) AS units FROM lv GROUP BY 1
  ),
  caps AS (
    SELECT x.uid, x.bucket, public.mos_user_daily_slots(x.uid, x.bucket) AS capacity
      FROM (SELECT DISTINCT uid, bucket FROM led) x
  ),
  ppl AS (
    SELECT uid FROM per UNION SELECT uid FROM stk UNION SELECT uid FROM lv
  ),
  dd AS (
    SELECT (v_today + g)::date AS day, public.mos_is_working_day((v_today + g)::date) AS working
      FROM generate_series(0, 29) g
  ),
  strip AS (
    SELECT p.uid,
           jsonb_agg(jsonb_build_object(
             'day', d.day,
             'off', NOT d.working,
             'leave', public.mos_on_leave(p.uid, d.day),
             'loads', COALESCE((
               SELECT jsonb_agg(jsonb_build_object(
                        'bucket', c.bucket,
                        'units', round(COALESCE(l.units, 0), 2),
                        'capacity', c.capacity) ORDER BY c.bucket)
                 FROM caps c
                 LEFT JOIN led l ON l.uid = c.uid AND l.bucket = c.bucket AND l.day = d.day
                WHERE c.uid = p.uid), '[]'::jsonb)
           ) ORDER BY d.day) AS days
      FROM ppl p CROSS JOIN dd d
     GROUP BY p.uid
  ),
  roles_of AS (
    SELECT p.uid,
           COALESCE(array_agg(DISTINCT substr(r.key, 5)) FILTER (WHERE r.key IS NOT NULL), '{}'::text[]) AS roles
      FROM ppl p
      JOIN public.users u ON u.id = p.uid
      LEFT JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(u.role_assignments) = 'array' THEN u.role_assignments ELSE '[]'::jsonb END) e ON true
      LEFT JOIN public.roles r ON r.id::text = e ->> 'role_id' AND r.key LIKE 'mos\_%' ESCAPE '\'
     GROUP BY p.uid
  )
  SELECT jsonb_build_object(
           'period', v_period,
           'from', v_from,
           'to', v_today,
           'horizon_days', 30,
           'team', (SELECT to_jsonb(team) FROM team) || jsonb_build_object(
             'strikes', COALESCE((SELECT sum(n) FROM stk), 0),
             'booked_items', (SELECT count(DISTINCT item) FROM lv),
             'booked_units', COALESCE((SELECT round(sum(weight), 1) FROM lv), 0)),
           'people', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'user_id', p.uid,
                      'name_ar', u.name_ar,
                      'name_en', u.name_en,
                      'roles', to_jsonb(COALESCE(ro.roles, '{}'::text[])),
                      'open_now', COALESCE(pr.open_now, 0),
                      'open_today', COALESCE(pr.open_today, 0),
                      'open_later', COALESCE(pr.open_later, 0),
                      'late_now', COALESCE(pr.late_now, 0),
                      'blocked_now', COALESCE(pr.blocked_now, 0),
                      'due_today', COALESCE(pr.due_today, 0),
                      'done', COALESCE(pr.done, 0),
                      'done_late', COALESCE(pr.done_late, 0),
                      'done_no_deadline', COALESCE(pr.done_no_deadline, 0),
                      'median_hours', pr.median_hours,
                      'strikes', COALESCE(s.n, 0),
                      'booked_items', COALESCE(b.items, 0),
                      'booked_units', COALESCE(round(b.units, 1), 0),
                      'days', COALESCE(st.days, '[]'::jsonb))
                    ORDER BY COALESCE(u.name_ar, u.name_en, p.uid::text))
               FROM ppl p
               LEFT JOIN public.users u ON u.id = p.uid
               LEFT JOIN per pr ON pr.uid = p.uid
               LEFT JOIN stk s ON s.uid = p.uid
               LEFT JOIN bk b ON b.uid = p.uid
               LEFT JOIN strip st ON st.uid = p.uid
               LEFT JOIN roles_of ro ON ro.uid = p.uid), '[]'::jsonb))
    INTO v_out;

  RETURN v_out;
END $fn$;

-- ─ post-conditions (guarded: an empty database passes trivially)
DO $assert$
DECLARE
  v jsonb;
BEGIN
  v := public.mos_team_kpis_core('month');
  IF (v -> 'team' ->> 'open_today')::int + (v -> 'team' ->> 'open_later')::int
     IS DISTINCT FROM (v -> 'team' ->> 'open_now')::int THEN
    RAISE EXCEPTION 'TEAM_KPIS_TODAY_SPLIT_TEAM %', v -> 'team';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'people') p
              WHERE (p ->> 'open_today')::int + (p ->> 'open_later')::int <> (p ->> 'open_now')::int) THEN
    RAISE EXCEPTION 'TEAM_KPIS_TODAY_SPLIT_PERSON';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.mos_team_kpis(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.mos_team_kpis_core(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'TEAM_KPIS_GRANTS_CHANGED';
  END IF;
END $assert$;

COMMIT;
