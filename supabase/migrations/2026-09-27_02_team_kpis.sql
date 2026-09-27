-- ============================================================================
-- Team KPIs — 2026-09-27.
--
-- The operator: «i need to be able to view the team tasks not the actual tasks
-- but the KPIS and how many tasks and stuff». This is the data behind the
-- «الفريق» tab on «مهامي»: per person, how much is open, late and due today,
-- how much was finished and how much of it on time, how long a task usually
-- takes, the lateness strikes, and the work booked for the next 30 days
-- against each person's daily limit. READ-ONLY: nothing here changes a task, a
-- booking or a strike.
--
--   1. Capability `view_team_kpis` — seeing the team's numbers, separate from
--      `manage_performance` (which can also approve deductions). Seeded for the
--      marketing manager and the CEO; an admin always passes wassell_mos_can.
--      Like every capability it is data: the Roles screen can grant it to more.
--   2. mos_team_kpis_core(period) — every number, computed in ONE place. Not
--      callable by app users: only the gated wrapper (and the service role).
--   3. mos_team_kpis(period) — the gate (42501 without the capability), then
--      the core. What the API calls, as the caller.
--
-- The counting rules (operator decisions, 2026-09-27):
--   • A task counts for the person it is ASSIGNED to, whoever closed it.
--   • Late = it earned a lateness strike (late_flag), or it was finished after
--     its deadline. In September both tests gave identical counts for every
--     person, so a late task here is a strike on the performance desk.
--   • On-time rate = on-time tasks ÷ finished tasks that had a deadline.
--   • Publishing is not a task: kind='publish' manual tasks never count.
--   • Period: 'month' = the Riyadh calendar month to date; 'week' = the last 7
--     days including today. Open, late, due-today and booked are always "now".
--   • Time to finish = hours from hand-off (assigned_at, else opened_at) to
--     closed_at, reported as the MEDIAN — a few slow tasks drag an average up.
--   • Booked ahead = mos_work_ledger_v for today + 29 days, against
--     mos_user_daily_slots per bucket, weekends/holidays and approved leave
--     marked — the same ledger and limits the capacity guard reads.
--
-- No SQLSTATE 40001/40P01 anywhere. Re-runnable.
-- ============================================================================

BEGIN;

-- 1 ─ the capability (data, like every other capability)
INSERT INTO public.role_capabilities (role_id, capability)
SELECT r.id, 'view_team_kpis'
  FROM public.roles r
 WHERE r.key IN ('mos_marketing_manager', 'mos_ceo')
ON CONFLICT (role_id, capability) DO NOTHING;

-- 2 ─ every number, in one place
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
           COALESCE(t.assigned_at, t.opened_at, t.created_at) AS start_at
      FROM public.workflow_role_tasks t
     WHERE t.assignee_user_id IS NOT NULL
       AND ((t.status = 'open'
             AND (t.subject_table <> 'mos_content'
                  OR EXISTS (SELECT 1 FROM public.mos_content c WHERE c.id = t.subject_id)))
         OR (t.status = 'done' AND t.closed_at >= v_from_ts AND t.closed_at < v_to_ts))
    UNION ALL
    -- Hand-assigned tasks. Publishing is not a task.
    SELECT m.assignee_user_id, m.status, m.due_at, m.closed_at, m.blocked, m.late_flag, m.created_at
      FROM public.mos_manual_tasks m
     WHERE m.assignee_user_id IS NOT NULL
       AND m.kind IS DISTINCT FROM 'publish'
       AND (m.status = 'open'
         OR (m.status = 'done' AND m.closed_at >= v_from_ts AND m.closed_at < v_to_ts))
  ),
  per AS (
    SELECT uid,
           count(*) FILTER (WHERE status = 'open') AS open_now,
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

COMMENT ON FUNCTION public.mos_team_kpis_core(text) IS
  'Team KPIs for the «الفريق» tab (2026-09-27). Read-only. Not for app users — call mos_team_kpis(), which gates on view_team_kpis.';

REVOKE ALL ON FUNCTION public.mos_team_kpis_core(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mos_team_kpis_core(text) TO service_role;

-- 3 ─ the gate
CREATE OR REPLACE FUNCTION public.mos_team_kpis(p_period text DEFAULT 'month')
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF NOT public.wassell_mos_can('view_team_kpis') THEN
    RAISE EXCEPTION 'view_team_kpis capability required' USING ERRCODE = '42501';
  END IF;
  RETURN public.mos_team_kpis_core(p_period);
END $fn$;

COMMENT ON FUNCTION public.mos_team_kpis(text) IS
  'Team KPIs for the «الفريق» tab, gated on the view_team_kpis capability (42501 otherwise).';

REVOKE ALL ON FUNCTION public.mos_team_kpis(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mos_team_kpis(text) TO authenticated, service_role;

-- ─ post-conditions (guarded: an empty database passes trivially)
DO $assert$
DECLARE
  n int;
  v jsonb;
BEGIN
  SELECT count(*) INTO n FROM public.roles r
   WHERE r.key IN ('mos_marketing_manager', 'mos_ceo')
     AND NOT EXISTS (SELECT 1 FROM public.role_capabilities rc
                      WHERE rc.role_id = r.id AND rc.capability = 'view_team_kpis');
  IF n <> 0 THEN RAISE EXCEPTION 'TEAM_KPIS_CAPABILITY_NOT_SEEDED %', n; END IF;

  v := public.mos_team_kpis_core('month');
  IF v ->> 'period' IS DISTINCT FROM 'month'
     OR jsonb_typeof(v -> 'people') IS DISTINCT FROM 'array'
     OR jsonb_typeof(v -> 'team') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'TEAM_KPIS_SHAPE_MONTH %', left(v::text, 300);
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v -> 'people') p
              WHERE jsonb_array_length(p -> 'days') <> 30) THEN
    RAISE EXCEPTION 'TEAM_KPIS_STRIP_NOT_30_DAYS';
  END IF;

  v := public.mos_team_kpis_core('week');
  IF v ->> 'period' IS DISTINCT FROM 'week' OR (v ->> 'to')::date - (v ->> 'from')::date <> 6 THEN
    RAISE EXCEPTION 'TEAM_KPIS_SHAPE_WEEK %', left(v::text, 300);
  END IF;

  -- A caller without the capability is refused with 42501 and nothing else. A
  -- migration runs with no JWT, so wassell_mos_can is false here; only that
  -- one error class is expected — any other failure still aborts the migration.
  BEGIN
    PERFORM public.mos_team_kpis('month');
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END $assert$;

COMMIT;
