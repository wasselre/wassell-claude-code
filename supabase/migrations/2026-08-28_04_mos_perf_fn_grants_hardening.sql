-- Advisor hardening (caught by get_advisors after the perf engine landed):
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on new functions to
-- anon/authenticated directly, so REVOKE FROM PUBLIC alone left anon able to
-- call the SECURITY DEFINER perf functions. Every one of them internally
-- gates on wassell_mos_can/auth.uid() (anon fails closed), but close the door
-- anyway. Internal-only helpers + the trigger function also drop
-- authenticated (they are called from definer/owner contexts only; the
-- user-facing RPCs keep authenticated — that is their calling surface).
REVOKE EXECUTE ON FUNCTION public.mos_perf_bucket_of(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mos_perf_sla_hours(text, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mos_perf_on_leave_now(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mos_perf_on_task_close() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mos_perf_place_open_task(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mos_perf_rate_content(uuid, text, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mos_perf_claim_reward(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mos_perf_decide_reward(uuid, boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mos_perf_decide_discipline(uuid, boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mos_perf_dispute_discipline(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mos_leave_request(timestamptz, timestamptz, text, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mos_leave_decide(uuid, boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mos_perf_task_block(text, uuid, boolean, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mos_perf_kpi_evaluate(text) FROM anon;

-- Trigger functions keep PUBLIC execute by default; revoke it too (the
-- trigger itself runs as table owner and needs no caller grant).
REVOKE ALL ON FUNCTION public.mos_perf_on_task_close() FROM PUBLIC;
