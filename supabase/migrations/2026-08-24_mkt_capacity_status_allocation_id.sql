-- ============================================================================
-- mkt_capacity_status now returns allocation_id with each campaign request.
-- Applied to production on 2026-07-28 as
--   mkt_capacity_status_include_allocation_id
--
-- WHY: resolving an over-allocation means granting less than was requested, so
-- the UI must be able to act on the exact rows the server reported for a week.
-- Without the id it re-derived those rows by filtering its own copy of the
-- allocations, which meant the conflict banner (server truth, per week) and the
-- editable list (client filter) could describe DIFFERENT weeks. Found by the
-- browser check: the banner said "over-allocated by 13" while the table below
-- said "no requests this week".
--
-- Purely additive to the JSON payload — existing callers ignore the new key.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.mkt_capacity_status(
  p_channel_plan_id uuid, p_week_start date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  ch record;
  v_prog int; v_camp int; v_reactive int; v_available int;
  v_requests jsonb;
BEGIN
  SELECT * INTO ch FROM public.mkt_channel_plans WHERE id = p_channel_plan_id;
  IF ch IS NULL THEN RETURN NULL; END IF;

  SELECT COALESCE(sum(slots_requested), 0) INTO v_prog
    FROM public.mkt_capacity_allocations
    WHERE channel_plan_id = p_channel_plan_id AND week_start = p_week_start
      AND allocation_kind = 'program_reservation';

  SELECT COALESCE(sum(slots_requested), 0) INTO v_camp
    FROM public.mkt_capacity_allocations
    WHERE channel_plan_id = p_channel_plan_id AND week_start = p_week_start
      AND allocation_kind = 'campaign_allocation';

  -- An explicit reactive_reserve row overrides the channel default, so one busy
  -- week can hold back more without editing the channel plan.
  SELECT COALESCE(sum(slots_requested), ch.reactive_reserve) INTO v_reactive
    FROM public.mkt_capacity_allocations
    WHERE channel_plan_id = p_channel_plan_id AND week_start = p_week_start
      AND allocation_kind = 'reactive_reserve';

  -- Capacity is only knowable when max_per_week is set. NULL means "not
  -- configured" and is reported as such, never as zero.
  v_available := CASE WHEN ch.max_per_week IS NULL THEN NULL
                      ELSE ch.max_per_week - v_prog - COALESCE(v_reactive, 0) END;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'allocation_id', a.id,
           'campaign_id',   a.campaign_id,
           'code',          c.code,
           'name_ar',       c.name_ar,
           'requested',     a.slots_requested,
           'granted',       a.slots_granted
         ) ORDER BY a.slots_requested DESC), '[]'::jsonb)
    INTO v_requests
    FROM public.mkt_capacity_allocations a
    JOIN public.mkt_internal_campaigns c ON c.id = a.campaign_id
   WHERE a.channel_plan_id = p_channel_plan_id AND a.week_start = p_week_start
     AND a.allocation_kind = 'campaign_allocation';

  RETURN jsonb_build_object(
    'channel_plan_id',  p_channel_plan_id,
    'platform',         ch.platform,
    'account_handle',   ch.account_handle,
    'week_start',       p_week_start,
    'capacity_configured', ch.max_per_week IS NOT NULL,
    'week_capacity',    ch.max_per_week,
    'program_reserved', v_prog,
    'reactive_reserved', COALESCE(v_reactive, 0),
    'campaign_available', v_available,
    'campaign_requested', v_camp,
    'over_allocated_by', CASE WHEN v_available IS NULL THEN NULL
                              WHEN v_camp > v_available THEN v_camp - v_available
                              ELSE 0 END,
    'is_over_allocated', CASE WHEN v_available IS NULL THEN NULL
                              ELSE v_camp > v_available END,
    'campaign_requests', v_requests
  );
END $$;

REVOKE ALL ON FUNCTION public.mkt_capacity_status(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mkt_capacity_status(uuid, date) TO authenticated, service_role;
