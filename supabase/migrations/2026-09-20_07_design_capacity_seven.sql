-- ============================================================================
-- The designer's day is SEVEN, and seven is the default. 2026-09-20.
--
-- Operator decision, raising the five set earlier the same day. "Default"
-- matters here: it means the ROLE's figure moves too, so a montage holder
-- added tomorrow starts at seven rather than inheriting a number nobody
-- remembers setting.
--
-- Three tables hold a design rate, because two engines read two different
-- ones, and the conformance job asserts they agree:
--
--   mos_step_rules.daily_limit      the DISPATCHER — what is handed out
--   mos_role_load.daily_new_tasks   the PLANNER's per-role default
--   mos_user_capacity.daily_slots   the PLANNER's per-user override
--
-- `daily_slots > 0` IS LOAD-BEARING, not a tidy filter. A zero means "holds
-- the role but is not a producer" — مدير النظام held montage that way until
-- the roles were tidied earlier today. The first run of the 5-a-day migration
-- raised "every montage holder" and handed the planner a phantom second
-- designer, halving the reported load until it was caught. So the guard below
-- counts the zeros BEFORE and AFTER and refuses if any were raised, rather
-- than assuming a particular person is the one holding a zero — that
-- assumption is exactly what broke this migration's first draft, minutes
-- after the roles changed underneath it.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_zeros_before int;
  v_zeros_after  int;
  v_rule int; v_role int; v_min int;
BEGIN
  SELECT count(*) INTO v_zeros_before
    FROM public.mos_user_capacity c
   WHERE c.bucket = 'post' AND c.daily_slots = 0 AND EXISTS (
     SELECT 1 FROM public.users u
       JOIN jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e ON true
       JOIN public.roles r ON r.id::text = e->>'role_id'
      WHERE u.id = c.user_id AND r.key = 'mos_montage');

  UPDATE public.mos_step_rules
     SET daily_limit = 7, updated_at = now()
   WHERE step_key = 'design' AND capacity_key = 'design';

  -- The default a new montage holder inherits.
  UPDATE public.mos_role_load
     SET daily_new_tasks = 7
   WHERE bucket = 'post'
     AND role_id = (SELECT id FROM public.roles WHERE key = 'mos_montage');

  UPDATE public.mos_user_capacity
     SET daily_slots = 7
   WHERE bucket = 'post'
     AND daily_slots > 0
     AND user_id IN (
       SELECT u.id FROM public.users u
        WHERE EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e
            JOIN public.roles r ON r.id::text = e->>'role_id'
           WHERE r.key = 'mos_montage')
     );

  SELECT count(*) INTO v_zeros_after
    FROM public.mos_user_capacity c
   WHERE c.bucket = 'post' AND c.daily_slots = 0 AND EXISTS (
     SELECT 1 FROM public.users u
       JOIN jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e ON true
       JOIN public.roles r ON r.id::text = e->>'role_id'
      WHERE u.id = c.user_id AND r.key = 'mos_montage');

  IF v_zeros_after <> v_zeros_before THEN
    RAISE EXCEPTION 'MOS:NON_PRODUCER_ZERO_LOST before=% after=%', v_zeros_before, v_zeros_after;
  END IF;

  SELECT daily_limit INTO v_rule FROM public.mos_step_rules WHERE step_key = 'design';
  SELECT daily_new_tasks INTO v_role FROM public.mos_role_load
   WHERE bucket = 'post' AND role_id = (SELECT id FROM public.roles WHERE key = 'mos_montage');
  SELECT min(daily_slots) INTO v_min FROM public.mos_user_capacity c
   WHERE c.bucket = 'post' AND c.daily_slots > 0 AND EXISTS (
     SELECT 1 FROM public.users u
       JOIN jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e ON true
       JOIN public.roles r ON r.id::text = e->>'role_id'
      WHERE u.id = c.user_id AND r.key = 'mos_montage');

  IF v_rule <> 7 OR v_role <> 7 OR COALESCE(v_min, 7) <> 7 THEN
    RAISE EXCEPTION 'MOS:DESIGN_CAP_NOT_SEVEN rule=% role=% user_min=%', v_rule, v_role, v_min;
  END IF;

  RAISE NOTICE 'design capacity = 7 (dispatcher, role default, % producer override(s))',
    (SELECT count(*) FROM public.mos_user_capacity c
      WHERE c.bucket = 'post' AND c.daily_slots = 7 AND EXISTS (
        SELECT 1 FROM public.users u
          JOIN jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e ON true
          JOIN public.roles r ON r.id::text = e->>'role_id'
         WHERE u.id = c.user_id AND r.key = 'mos_montage'));
END $$;

COMMIT;
