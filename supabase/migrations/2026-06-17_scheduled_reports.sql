-- Scheduled Reports — the second consumer of the universal analytics engine
-- (after dashboards). A report runs a stored AnalyticsQuery / dashboard / widget
-- / metric on a Riyadh schedule via the Fly worker, renders an email, and
-- delivers it (or stores a draft when no email provider is configured).
--
-- NO second analytics implementation: the runner endpoint executes the same
-- runAnalyticsQuery the dashboards use, scoped to the report OWNER's RLS.
--
-- Tables:
--   scheduled_reports      — config + last-run state (admin-RLS, like dashboards)
--   scheduled_report_runs  — per-run history (for "view last runs" + errors)
--
-- Scheduling: the worker polls scheduled_report_claim_due() every few seconds and
-- runs anything whose next_run_at has passed. No pg_cron, no second scheduler —
-- the same poll-loop pattern as deck_jobs / generation_jobs / file_preview_jobs.
--
-- Applied to wassell-prod 2026-06-17 via the Supabase MCP. Idempotent.

-- ── Config table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduled_reports (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title              TEXT NOT NULL,
  owner_user_id      UUID,                 -- app user (display)
  owner_auth_uid     UUID,                 -- auth.users id — for owner-scoped JWT minting in the runner
  -- Schedule (all interpreted in Asia/Riyadh):
  frequency          TEXT NOT NULL DEFAULT 'daily'   -- 'daily' | 'weekly' | 'monthly'
                       CHECK (frequency IN ('daily','weekly','monthly')),
  hour_of_day        INT  NOT NULL DEFAULT 8         -- 0..23, Riyadh
                       CHECK (hour_of_day BETWEEN 0 AND 23),
  day_of_week        INT  CHECK (day_of_week BETWEEN 0 AND 6),    -- 0=Sun, for weekly
  day_of_month       INT  CHECK (day_of_month BETWEEN 1 AND 28),  -- for monthly (≤28 = always valid)
  timezone           TEXT NOT NULL DEFAULT 'Asia/Riyadh',
  recipients         JSONB NOT NULL DEFAULT '[]'::jsonb,          -- array of email strings
  delivery_channel   TEXT NOT NULL DEFAULT 'email' CHECK (delivery_channel IN ('email')),
  -- Source (what to compute):
  source_type        TEXT NOT NULL CHECK (source_type IN ('dashboard','widget','metric','custom')),
  dashboard_id       UUID,                 -- dashboard / widget sources
  widget_id          TEXT,                 -- widget source (widget id within the dashboard)
  metric_id          UUID,                 -- metric source
  query              JSONB,                -- custom source (an AnalyticsQuery)
  -- State:
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','paused','running','error')),
  last_run_at        TIMESTAMPTZ,
  next_run_at        TIMESTAMPTZ,
  last_status        TEXT,                 -- last run outcome: 'sent' | 'draft' | 'failed' | 'partial'
  last_result_snapshot JSONB,             -- compact summary of the last run (results, data_as_of, counts)
  error_message      TEXT,
  worker_id          TEXT,                 -- set while status='running'
  running_since      TIMESTAMPTZ,          -- for the watchdog
  created_by_user_id UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_reports_due
  ON public.scheduled_reports (next_run_at)
  WHERE status = 'active';

-- ── Run history ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.scheduled_report_runs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_id       UUID NOT NULL REFERENCES public.scheduled_reports(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','sent','draft','failed','partial')),
  triggered_by    TEXT NOT NULL DEFAULT 'schedule' CHECK (triggered_by IN ('schedule','manual')),
  data_as_of      TIMESTAMPTZ,
  result_snapshot JSONB,        -- the AnalyticsResult(s) WITHOUT record ids + the rendered summary
  warnings        JSONB,
  recipients      JSONB,
  delivery        TEXT,         -- 'sent' | 'draft' | 'skipped'
  error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_report_runs_report
  ON public.scheduled_report_runs (report_id, started_at DESC);

-- ── Riyadh-aware next-run computation (the ONLY scheduling date math) ───────
CREATE OR REPLACE FUNCTION public.scheduled_report_next_run(
  p_frequency TEXT, p_hour INT, p_dow INT, p_dom INT, p_after TIMESTAMPTZ
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql IMMUTABLE
AS $$
DECLARE
  tz        TEXT := 'Asia/Riyadh';
  local_now TIMESTAMP;       -- Riyadh wall-clock of p_after
  cand      TIMESTAMP;       -- candidate Riyadh wall-clock
  add_days  INT;
BEGIN
  local_now := (p_after AT TIME ZONE tz);
  IF p_frequency = 'weekly' THEN
    -- next occurrence of day_of_week (0=Sun) at hour, strictly after local_now
    cand := date_trunc('day', local_now) + make_interval(hours => COALESCE(p_hour,8));
    add_days := ((COALESCE(p_dow,0) - EXTRACT(DOW FROM local_now)::int) % 7 + 7) % 7;
    cand := cand + make_interval(days => add_days);
    IF cand <= local_now THEN cand := cand + interval '7 days'; END IF;
  ELSIF p_frequency = 'monthly' THEN
    -- this month's day_of_month at hour; if passed, next month
    cand := date_trunc('month', local_now)
            + make_interval(days => COALESCE(p_dom,1) - 1, hours => COALESCE(p_hour,8));
    IF cand <= local_now THEN
      cand := date_trunc('month', local_now + interval '1 month')
              + make_interval(days => COALESCE(p_dom,1) - 1, hours => COALESCE(p_hour,8));
    END IF;
  ELSE  -- daily
    cand := date_trunc('day', local_now) + make_interval(hours => COALESCE(p_hour,8));
    IF cand <= local_now THEN cand := cand + interval '1 day'; END IF;
  END IF;
  RETURN (cand AT TIME ZONE tz);  -- interpret the Riyadh wall-clock candidate as a UTC instant
END;
$$;

-- ── Claim due reports (worker, SKIP LOCKED) ────────────────────────────────
-- Flips active→running + stamps worker/running_since so two workers never run
-- the same report. Returns the claimed rows for the worker to trigger.
CREATE OR REPLACE FUNCTION public.scheduled_report_claim_due(p_worker_id TEXT, p_limit INT DEFAULT 5)
RETURNS SETOF public.scheduled_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.scheduled_reports r
     SET status = 'running', worker_id = p_worker_id, running_since = now(), updated_at = now()
   WHERE r.id IN (
     SELECT id FROM public.scheduled_reports
      WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= now()
      ORDER BY next_run_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
   RETURNING r.*;
END;
$$;

-- ── Watchdog: reset reports stuck 'running' (worker crash mid-run) ──────────
CREATE OR REPLACE FUNCTION public.scheduled_reports_watchdog()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE n INT;
BEGIN
  -- A run shouldn't take >10 min. Reset to 'active' so it retries on the next
  -- due tick (next_run_at is in the past → picked up immediately). Records a
  -- loud error so it's never a silent stall.
  UPDATE public.scheduled_reports
     SET status = 'active', worker_id = NULL, running_since = NULL,
         last_status = 'failed',
         error_message = COALESCE(error_message, 'watchdog: run exceeded 10 min and was reset'),
         updated_at = now()
   WHERE status = 'running' AND running_since < now() - interval '10 minutes';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- ── RLS: admin-only, like dashboards (report owners are admins in v1) ───────
ALTER TABLE public.scheduled_reports     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_report_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduled_reports_admin ON public.scheduled_reports;
CREATE POLICY scheduled_reports_admin ON public.scheduled_reports
  FOR ALL TO authenticated
  USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));

DROP POLICY IF EXISTS scheduled_report_runs_admin ON public.scheduled_report_runs;
CREATE POLICY scheduled_report_runs_admin ON public.scheduled_report_runs
  FOR ALL TO authenticated
  USING (wassell_is_admin((SELECT auth.uid()))) WITH CHECK (wassell_is_admin((SELECT auth.uid())));

-- updated_at trigger (reuse the shared function)
DROP TRIGGER IF EXISTS set_updated_at_scheduled_reports ON public.scheduled_reports;
CREATE TRIGGER set_updated_at_scheduled_reports BEFORE UPDATE ON public.scheduled_reports
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Fill next_run_at on insert / schedule-edit / resume. Excludes the running→active
-- transition so the runner's own next_run_at write is never clobbered.
-- (Applied separately as 2026-06-17_scheduled_reports_fill_next_run; recorded here.)
CREATE OR REPLACE FUNCTION public.scheduled_reports_fill_next_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.next_run_at IS NULL THEN
      NEW.next_run_at := public.scheduled_report_next_run(NEW.frequency, NEW.hour_of_day, NEW.day_of_week, NEW.day_of_month, now());
    END IF;
  ELSE
    IF NEW.frequency   IS DISTINCT FROM OLD.frequency
    OR NEW.hour_of_day IS DISTINCT FROM OLD.hour_of_day
    OR NEW.day_of_week IS DISTINCT FROM OLD.day_of_week
    OR NEW.day_of_month IS DISTINCT FROM OLD.day_of_month
    OR (NEW.status = 'active' AND OLD.status NOT IN ('active','running'))
    THEN
      NEW.next_run_at := public.scheduled_report_next_run(NEW.frequency, NEW.hour_of_day, NEW.day_of_week, NEW.day_of_month, now());
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS scheduled_reports_fill_next_run ON public.scheduled_reports;
CREATE TRIGGER scheduled_reports_fill_next_run
  BEFORE INSERT OR UPDATE ON public.scheduled_reports
  FOR EACH ROW EXECUTE FUNCTION public.scheduled_reports_fill_next_run();
