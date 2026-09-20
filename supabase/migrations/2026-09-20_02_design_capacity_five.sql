-- ============================================================================
-- The designer's day is FIVE, in every place that counts one. 2026-09-20.
--
-- Operator decision. At four, the STANDING month does not fit: 16 rows x 3 +
-- 4 batches x 5 creatives x 3 projects = 108 design units against 24 working
-- days x 4 = 96 — 113%, every month, and nothing ever reported it. At five it
-- is 108 against 120 = 90%.
--
-- The rate lives in THREE places because two engines read two different tables:
--
--   mos_step_rules.daily_limit      the DISPATCHER — what is handed out
--   mos_user_capacity.daily_slots   the PLANNER — what the forecast believes
--   mos_role_load.daily_new_tasks   the planner's fallback for a holder with
--                                   no per-user override
--
-- Changing one and not the others is the exact drift that produced the
-- 2026-09-20 incident: a forecast and a hand-out gate that disagree and never
-- compare notes. The conformance test added in this build asserts they agree;
-- this migration is what it will assert about.
-- ============================================================================

BEGIN;

UPDATE public.mos_step_rules
   SET daily_limit = 5, updated_at = now()
 WHERE step_key = 'design' AND capacity_key = 'design';

-- `daily_slots > 0` is LOAD-BEARING, not a tidy filter. مدير النظام holds every
-- role including montage, and his production capacity is a deliberate ZERO: he
-- approves, he does not design. Raising every montage holder to 5 gave the
-- planner a phantom second designer and halved the reported load — caught on
-- the first run of this migration, 2026-09-20. A zero means "not a producer"
-- and must survive any capacity change.
UPDATE public.mos_user_capacity
   SET daily_slots = 5
 WHERE bucket = 'post'
   AND daily_slots > 0
   AND user_id IN (
     SELECT u.id FROM public.users u
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e
          JOIN public.roles r ON r.id::text = e->>'role_id'
         WHERE r.key = 'mos_montage')
   );

UPDATE public.mos_role_load
   SET daily_new_tasks = 5
 WHERE bucket = 'post'
   AND role_id = (SELECT id FROM public.roles WHERE key = 'mos_montage');

DO $$
DECLARE v_rule int; v_role int; v_min int;
BEGIN
  SELECT daily_limit INTO v_rule FROM public.mos_step_rules WHERE step_key = 'design';
  SELECT daily_new_tasks INTO v_role FROM public.mos_role_load
   WHERE bucket = 'post' AND role_id = (SELECT id FROM public.roles WHERE key = 'mos_montage');
  SELECT min(daily_slots) INTO v_min FROM public.mos_user_capacity c
   WHERE c.bucket = 'post' AND c.daily_slots > 0 AND EXISTS (
     SELECT 1 FROM public.users u
       JOIN jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e ON true
       JOIN public.roles r ON r.id::text = e->>'role_id'
      WHERE u.id = c.user_id AND r.key = 'mos_montage');
  IF v_rule <> 5 OR v_role <> 5 OR COALESCE(v_min, 5) <> 5 THEN
    RAISE EXCEPTION 'MOS:DESIGN_CAP_NOT_FIVE rule=% role=% user_min=%', v_rule, v_role, v_min;
  END IF;
END $$;

COMMIT;
