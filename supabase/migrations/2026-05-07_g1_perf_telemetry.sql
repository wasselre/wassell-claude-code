-- ============================================================
-- Phase G.1 — pg_stat_statements + slow_query_log
-- ============================================================
-- pg_stat_statements is already enabled on this Supabase project.
-- This migration adds a thin admin-only wrapper that returns the
-- slowest queries with sensible columns and threshold filtering.
--
-- Why a function instead of a view:
--   * pg_stat_statements rows can include sensitive query text
--     (SELECTs that name customer-facing values via inlined literals,
--     RPC calls with user-provided JSONB). A SECURITY DEFINER function
--     gives us a single chokepoint to enforce admin-only access.
--   * RLS doesn't apply to extension catalog views; we'd otherwise
--     need to revoke broadly + re-grant carefully.
--
-- Usage:
--   SELECT * FROM slow_query_log();              -- mean > 1000ms
--   SELECT * FROM slow_query_log(p_threshold_ms => 100);
--
-- Verification:
--   Run a slow query (pg_sleep(2)) then SELECT * FROM slow_query_log()
--   — the sleep query should appear at the top.
-- ============================================================

CREATE OR REPLACE FUNCTION public.slow_query_log(
  p_threshold_ms numeric DEFAULT 1000,
  p_limit        int     DEFAULT 50
)
RETURNS TABLE(
  query    text,
  calls    bigint,
  total_ms numeric,
  mean_ms  numeric,
  max_ms   numeric,
  rows_returned bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog, pg_temp
AS $fn$
BEGIN
  -- Admin-only: pg_stat_statements may surface inlined literals.
  IF NOT public.wassell_is_admin((SELECT auth.uid())) THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    s.query,
    s.calls,
    round(s.total_exec_time::numeric, 2) AS total_ms,
    round(s.mean_exec_time::numeric, 2)  AS mean_ms,
    round(s.max_exec_time::numeric, 2)   AS max_ms,
    s.rows AS rows_returned
  FROM pg_stat_statements s
  WHERE s.mean_exec_time > p_threshold_ms
  ORDER BY s.total_exec_time DESC
  LIMIT GREATEST(1, LEAST(p_limit, 500));
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.slow_query_log(numeric, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.slow_query_log(numeric, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.slow_query_log(numeric, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.slow_query_log(numeric, int) TO service_role;

-- ── Lightweight perf snapshot table (optional weekly capture) ────
-- Records a point-in-time slow-query view so we can see how perf
-- evolves over weeks without relying on pg_stat_statements not being
-- reset (the view auto-resets on cluster restart and on calls to
-- pg_stat_statements_reset).
CREATE TABLE IF NOT EXISTS public.query_perf_snapshot (
  id          bigserial PRIMARY KEY,
  taken_at    timestamptz NOT NULL DEFAULT now(),
  threshold_ms numeric NOT NULL,
  rows        jsonb   NOT NULL  -- array of {query, calls, total_ms, mean_ms, max_ms, rows}
);
CREATE INDEX IF NOT EXISTS idx_query_perf_snapshot_taken_at ON public.query_perf_snapshot(taken_at DESC);

ALTER TABLE public.query_perf_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS query_perf_snapshot_admin ON public.query_perf_snapshot;
CREATE POLICY query_perf_snapshot_admin ON public.query_perf_snapshot FOR ALL TO authenticated
  USING (public.wassell_is_admin((SELECT auth.uid())))
  WITH CHECK (public.wassell_is_admin((SELECT auth.uid())));

REVOKE ALL ON TABLE public.query_perf_snapshot FROM anon;
GRANT SELECT, INSERT, DELETE ON TABLE public.query_perf_snapshot TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.query_perf_snapshot_id_seq TO authenticated;

-- Helper to take a snapshot (admin-only via underlying slow_query_log).
CREATE OR REPLACE FUNCTION public.snapshot_slow_queries(
  p_threshold_ms numeric DEFAULT 1000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_catalog, pg_temp
AS $fn$
DECLARE
  v_id bigint;
  v_rows jsonb;
BEGIN
  IF NOT public.wassell_is_admin((SELECT auth.uid())) THEN
    RAISE EXCEPTION 'admin access required' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'query', query,
    'calls', calls,
    'total_ms', total_ms,
    'mean_ms', mean_ms,
    'max_ms', max_ms,
    'rows', rows_returned
  )), '[]'::jsonb)
  INTO v_rows
  FROM public.slow_query_log(p_threshold_ms, 100);

  INSERT INTO public.query_perf_snapshot (threshold_ms, rows)
  VALUES (p_threshold_ms, v_rows)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.snapshot_slow_queries(numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.snapshot_slow_queries(numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.snapshot_slow_queries(numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_slow_queries(numeric) TO service_role;
