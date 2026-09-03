-- Paid-media analytics aggregation for the Marketing dashboard redesign.
--
-- One RPC returns everything the التحليلات (Analytics) page + the period-scoped
-- Paid card on the Overview need for a [p_from, p_to) date range, so the
-- endpoint never fetches raw daily rows.
--
-- Data reality (important):
--   • mos_execution_daily has spend/leads/qualified PER DAY  -> real daily series.
--   • impressions/clicks live ONLY on mos_campaign_executions as lifetime totals
--     (no daily breakdown), so CPM/CPC/CTR are PERIOD AGGREGATES from executions
--     overlapping the range, NOT a daily trend. CPL/spend/leads ARE exact per-day.
--   • Undated executions (starts_on IS NULL) are always included: their totals
--     can't be attributed to a period, so they surface in every range until dated.
--
-- SECURITY DEFINER: the endpoint gates on the marketing `read` capability and
-- calls this via the service client (same posture as mkt_content_readiness).

create or replace function public.mos_paid_analytics(p_from date, p_to date)
returns jsonb
language sql
security definer
set search_path = public
as $$
  with daily as (
    select d.day,
           sum(d.spend)::numeric     as spend,
           sum(d.leads)::int         as leads,
           sum(d.qualified)::int     as qualified
    from mos_execution_daily d
    where d.day >= p_from and d.day < p_to
    group by d.day
  ),
  daily_tot as (
    select coalesce(sum(spend),0)::numeric  as spend,
           coalesce(sum(leads),0)::int      as leads,
           coalesce(sum(qualified),0)::int  as qualified,
           count(*)::int                    as days
    from daily
  ),
  ex as (
    select e.campaign_id, e.platform,
           coalesce(e.spend,0)::numeric        as spend,
           coalesce(e.impressions,0)::bigint   as impressions,
           coalesce(e.clicks,0)::bigint        as clicks,
           coalesce(e.leads,0)::int            as leads,
           coalesce(e.qualified,0)::int        as qualified
    from mos_campaign_executions e
    where e.starts_on is null
       or (e.starts_on < p_to and (e.ends_on is null or e.ends_on >= p_from))
  ),
  ex_tot as (
    select coalesce(sum(impressions),0)::bigint as impressions,
           coalesce(sum(clicks),0)::bigint      as clicks,
           coalesce(sum(spend),0)::numeric      as exec_spend,
           coalesce(sum(leads),0)::int          as exec_leads
    from ex
  ),
  by_platform as (
    select platform,
           sum(spend)::numeric       as spend,
           sum(impressions)::bigint  as impressions,
           sum(clicks)::bigint       as clicks,
           sum(leads)::int           as leads
    from ex
    group by platform
  ),
  by_campaign as (
    select c.id, c.name,
           sum(ex.spend)::numeric       as spend,
           sum(ex.impressions)::bigint  as impressions,
           sum(ex.clicks)::bigint       as clicks,
           sum(ex.leads)::int           as leads,
           sum(ex.qualified)::int       as qualified
    from ex
    join mos_campaigns c on c.id = ex.campaign_id
    group by c.id, c.name
  )
  select jsonb_build_object(
    'from', p_from,
    'to',   p_to,
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', day, 'spend', spend, 'leads', leads, 'qualified', qualified) order by day)
      from daily), '[]'::jsonb),
    'totals', jsonb_build_object(
      'spend',       (select spend from daily_tot),
      'leads',       (select leads from daily_tot),
      'qualified',   (select qualified from daily_tot),
      'daily_days',  (select days from daily_tot),
      'impressions', (select impressions from ex_tot),
      'clicks',      (select clicks from ex_tot),
      'exec_spend',  (select exec_spend from ex_tot),
      'exec_leads',  (select exec_leads from ex_tot)
    ),
    'by_platform', coalesce((
      select jsonb_agg(jsonb_build_object(
        'platform', platform, 'spend', spend, 'impressions', impressions,
        'clicks', clicks, 'leads', leads) order by spend desc)
      from by_platform), '[]'::jsonb),
    'by_campaign', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'spend', spend, 'impressions', impressions,
        'clicks', clicks, 'leads', leads, 'qualified', qualified) order by spend desc)
      from by_campaign), '[]'::jsonb)
  );
$$;

grant execute on function public.mos_paid_analytics(date, date) to authenticated, service_role;
