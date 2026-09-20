-- ============================================================================
-- The backlog is VISIBLE while it is building, not six weeks later.
-- 2026-09-20.
--
-- The forecast is now honest (`summary.unscheduled`, `summary.demand`), but a
-- forecast is a prediction. Reality drifts: someone takes leave, a design comes
-- back for revision, a month is started late. When that happens the dispatcher
-- does exactly the right thing — it parks the work with
-- `waiting_reason = 'capacity'` and hands it out as room appears — and says
-- nothing to anybody. On 2026-09-20 sixty ad creatives would have queued that
-- way into November and the only signal would have been a per-task pill on a
-- page nobody opens.
--
-- `mos_capacity_backlog()` is that signal: per capacity key, how many UNITS are
-- waiting (not tasks — a row is three), how long the oldest has waited, and
-- the nearest publish date the queue is threatening. Units and the nearest
-- deadline are the two numbers that say whether a backlog matters; a task count
-- alone says neither.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_capacity_backlog()
RETURNS TABLE (
  capacity_key        text,
  role_key            text,
  waiting_tasks       int,
  waiting_units       numeric,
  daily_limit         int,
  holders             int,
  days_to_clear       numeric,
  oldest_waiting_at   timestamptz,
  oldest_waiting_hours numeric,
  next_publish_at     timestamptz,
  next_publish_in_hours numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  WITH waiting AS (
    SELECT
      sr.capacity_key,
      t.role_key,
      COALESCE(t.units, public.mos_task_units(t.subject_table, t.subject_id), 1) AS units,
      COALESCE(t.waiting_since, t.created_at) AS since,
      public.mos_subject_publish_at(t.subject_table, t.subject_id) AS publish_at,
      sr.daily_limit
    FROM public.workflow_role_tasks t
    JOIN public.mos_step_rules sr ON sr.step_key = t.step_key
   WHERE t.status = 'open'
     AND t.assignee_user_id IS NULL
     AND t.waiting_since IS NOT NULL
     AND t.waiting_reason = 'capacity'
     AND sr.capacity_key IS NOT NULL
     AND NOT public.mos_subject_inactive(t.subject_table, t.subject_id)
  ),
  holders AS (
    SELECT sr.capacity_key, w.role_key, count(*)::int AS n
      FROM (SELECT DISTINCT capacity_key, role_key FROM waiting) w
      JOIN public.mos_step_rules sr ON sr.capacity_key = w.capacity_key
     CROSS JOIN LATERAL public.mos_role_routine_holders(w.role_key) h(uid)
     GROUP BY 1, 2
  )
  SELECT
    w.capacity_key,
    w.role_key,
    count(*)::int                                            AS waiting_tasks,
    sum(w.units)                                             AS waiting_units,
    max(w.daily_limit)                                       AS daily_limit,
    COALESCE(max(h.n), 0)                                    AS holders,
    -- Working days to clear at the current rate. NULL — not zero — when there
    -- is nobody holding the role: "it never clears" is not "it clears today".
    CASE WHEN COALESCE(max(h.n), 0) > 0 AND max(w.daily_limit) > 0
         THEN round(sum(w.units) / (COALESCE(max(h.n), 0) * max(w.daily_limit))::numeric, 1)
    END                                                      AS days_to_clear,
    min(w.since)                                             AS oldest_waiting_at,
    round(EXTRACT(EPOCH FROM (now() - min(w.since))) / 3600.0, 1) AS oldest_waiting_hours,
    min(w.publish_at)                                        AS next_publish_at,
    round(EXTRACT(EPOCH FROM (min(w.publish_at) - now())) / 3600.0, 1) AS next_publish_in_hours
  FROM waiting w
  LEFT JOIN holders h ON h.capacity_key = w.capacity_key AND h.role_key = w.role_key
  GROUP BY w.capacity_key, w.role_key
  ORDER BY sum(w.units) DESC
$$;

REVOKE ALL ON FUNCTION public.mos_capacity_backlog() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mos_capacity_backlog() TO authenticated, service_role;

DO $$
DECLARE v_rows int;
BEGIN
  -- It must RUN, and on a healthy system it returns nothing. Both matter: a
  -- function that errors is invisible in exactly the same way as a backlog
  -- nobody reports.
  SELECT count(*) INTO v_rows FROM public.mos_capacity_backlog();
  RAISE NOTICE 'mos_capacity_backlog OK — % capacity key(s) currently backlogged', v_rows;
END $$;

COMMIT;
