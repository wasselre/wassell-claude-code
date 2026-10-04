-- ============================================================================
-- mos_paid_analytics: read the per-day Meta figures, so a period means a period.
--
-- THE BUG (reported 2026-10-04: "the numbers are wrong for the month").
-- The Analytics page showed 8,714 SAR · 329 leads · 116,932 impressions ·
-- 1,620 clicks for EVERY period — week, month, quarter, year — with "0% vs
-- previous" on every card. Those are the all-time totals. The RPC took its
-- dated figures from `mos_execution_daily`, which has ZERO rows (it is the
-- hand-entry table, never used), so it always fell back to the lifetime totals
-- on `mos_campaign_executions`, and 7 of those 11 executions have no start
-- date, so they matched every window. The current and previous windows were
-- therefore the same number, hence the flat 0% deltas.
--
-- We DO hold per-day paid figures: `mos_ad_metrics_daily` (Meta sync, one row
-- per ad per day — 385 rows, 2026-08-15 → today). Measured on production:
--   Aug 3,037.47 SAR · Sep 4,646.43 · Oct (1–4) 552.15 — all of it dated.
-- `mos_month_metrics` already reads it; this RPC was the one left behind.
--
-- WHAT CHANGES
--   • spend / impressions / clicks / leads come from `mos_ad_metrics_daily`
--     inside [p_from, p_to) — a real daily series, including impressions and
--     clicks, so CPM/CPC/CTR are now period figures that actually move.
--   • `mos_execution_daily` (hand-entered) still counts, but ONLY for an
--     execution that has no Meta daily rows at all — otherwise one day's spend
--     would be counted twice once someone typed it in by hand as well.
--   • `exec_spend` / `exec_leads` are now honestly LIFETIME (every execution's
--     stored total). The Overview labels them "all campaigns, to date"; before,
--     they were "lifetime of executions overlapping the window", which only
--     happened to equal lifetime because the dates were missing.
--   • `undated_spend` / `undated_leads`: lifetime money we hold with NO daily
--     breakdown (today: one early «مينا 52» run, 481.84 SAR / 16 leads, whose
--     two ads predate the daily sync). It cannot be placed in a period, so it
--     is reported beside the period, never folded into it.
--
-- Shape is a superset of the old one — every key the Overview reads is still
-- there. SECURITY DEFINER + service-client caller, same as before. Never raises
-- SQLSTATE 40001/40P01. Idempotent.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.mos_paid_analytics(p_from date, p_to date)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH
  ad_map AS (
    SELECT a.id AS ad_row_id, e.id AS execution_id, e.campaign_id,
           COALESCE(e.platform, 'meta') AS platform
      FROM mos_execution_ads a
      LEFT JOIN mos_campaign_executions e ON e.id = a.execution_id
  ),
  -- Executions whose numbers come from the Meta daily sync.
  synced_exec AS (
    SELECT DISTINCT m.execution_id
      FROM mos_ad_metrics_daily d
      JOIN ad_map m ON m.ad_row_id = d.ad_row_id
     WHERE m.execution_id IS NOT NULL
  ),
  -- One row per (source row, day) inside the window.
  rows_in AS (
    SELECT d.day, m.execution_id, m.campaign_id, m.platform,
           COALESCE(d.spend, 0)::numeric       AS spend,
           COALESCE(d.impressions, 0)::bigint  AS impressions,
           COALESCE(d.clicks, 0)::bigint       AS clicks,
           COALESCE(d.leads, 0)::bigint        AS leads,
           0::int                              AS qualified
      FROM mos_ad_metrics_daily d
      JOIN ad_map m ON m.ad_row_id = d.ad_row_id
     WHERE d.day >= p_from AND d.day < p_to
    UNION ALL
    SELECT x.day, x.execution_id, e.campaign_id, COALESCE(e.platform, 'meta'),
           COALESCE(x.spend, 0)::numeric, 0::bigint, 0::bigint,
           COALESCE(x.leads, 0)::bigint, COALESCE(x.qualified, 0)::int
      FROM mos_execution_daily x
      JOIN mos_campaign_executions e ON e.id = x.execution_id
     WHERE x.day >= p_from AND x.day < p_to
       AND NOT EXISTS (SELECT 1 FROM synced_exec s WHERE s.execution_id = x.execution_id)
  ),
  daily AS (
    SELECT day,
           sum(spend)::numeric       AS spend,
           sum(leads)::bigint        AS leads,
           sum(qualified)::int       AS qualified,
           sum(impressions)::bigint  AS impressions,
           sum(clicks)::bigint       AS clicks
      FROM rows_in GROUP BY day
  ),
  tot AS (
    SELECT COALESCE(sum(spend), 0)::numeric       AS spend,
           COALESCE(sum(leads), 0)::bigint        AS leads,
           COALESCE(sum(qualified), 0)::int       AS qualified,
           COALESCE(sum(impressions), 0)::bigint  AS impressions,
           COALESCE(sum(clicks), 0)::bigint       AS clicks,
           count(*)::int                          AS days
      FROM daily
  ),
  -- Lifetime, and the part of it that has no daily breakdown at all.
  life AS (
    SELECT COALESCE(sum(e.spend), 0)::numeric AS spend,
           COALESCE(sum(e.leads), 0)::int     AS leads,
           COALESCE(sum(e.spend) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM synced_exec s WHERE s.execution_id = e.id)
             AND NOT EXISTS (SELECT 1 FROM mos_execution_daily x WHERE x.execution_id = e.id)), 0)::numeric AS undated_spend,
           COALESCE(sum(e.leads) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM synced_exec s WHERE s.execution_id = e.id)
             AND NOT EXISTS (SELECT 1 FROM mos_execution_daily x WHERE x.execution_id = e.id)), 0)::int AS undated_leads
      FROM mos_campaign_executions e
  ),
  by_platform AS (
    SELECT platform,
           sum(spend)::numeric       AS spend,
           sum(impressions)::bigint  AS impressions,
           sum(clicks)::bigint       AS clicks,
           sum(leads)::bigint        AS leads
      FROM rows_in GROUP BY platform
  ),
  by_campaign AS (
    SELECT c.id, c.name,
           sum(r.spend)::numeric       AS spend,
           sum(r.impressions)::bigint  AS impressions,
           sum(r.clicks)::bigint       AS clicks,
           sum(r.leads)::bigint        AS leads,
           sum(r.qualified)::int       AS qualified
      FROM rows_in r
      JOIN mos_campaigns c ON c.id = r.campaign_id
     GROUP BY c.id, c.name
  )
  SELECT jsonb_build_object(
    'from', p_from,
    'to',   p_to,
    'daily', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'day', day, 'spend', spend, 'leads', leads, 'qualified', qualified,
        'impressions', impressions, 'clicks', clicks) ORDER BY day)
      FROM daily), '[]'::jsonb),
    'totals', jsonb_build_object(
      'spend',         (SELECT spend FROM tot),
      'leads',         (SELECT leads FROM tot),
      'qualified',     (SELECT qualified FROM tot),
      'daily_days',    (SELECT days FROM tot),
      'impressions',   (SELECT impressions FROM tot),
      'clicks',        (SELECT clicks FROM tot),
      'exec_spend',    (SELECT spend FROM life),
      'exec_leads',    (SELECT leads FROM life),
      'undated_spend', (SELECT undated_spend FROM life),
      'undated_leads', (SELECT undated_leads FROM life)
    ),
    'by_platform', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'platform', platform, 'spend', spend, 'impressions', impressions,
        'clicks', clicks, 'leads', leads) ORDER BY spend DESC)
      FROM by_platform), '[]'::jsonb),
    'by_campaign', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'spend', spend, 'impressions', impressions,
        'clicks', clicks, 'leads', leads, 'qualified', qualified) ORDER BY spend DESC)
      FROM by_campaign), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.mos_paid_analytics(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mos_paid_analytics(date, date) TO authenticated, service_role;

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'mos_paid_analytics'
       AND has_function_privilege('anon', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'MOS:ANON_CAN_EXECUTE — mos_paid_analytics';
  END IF;
END $assert$;

COMMIT;
