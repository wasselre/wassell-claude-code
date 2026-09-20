-- ============================================================================
-- The PLANNER and the DISPATCHER must count the same work the same way.
--
-- Added 2026-09-20 after the capacity audit. The month planner (TypeScript,
-- `monthCompiler.ts`) decides "does this month fit?". The dispatcher (SQL,
-- `mos_task_dispatch`) decides "can this person be handed this task?". They
-- read DIFFERENT tables and, until that day, had never once been compared:
-- `mos_task_units` had zero references anywhere in the TypeScript codebase.
--
-- They happened to agree at 159 units. Nothing made them. This file, plus
-- `engineConformance.test.ts` on the TypeScript side, is what makes them.
--
-- Run against the ephemeral CI database by the `db-migrations` job.
-- ============================================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_design   int;
  v_writing  int;
  v_role     int;
  v_user_min int;
  v_missing  text;
BEGIN
  -- ── 1. Every capacity-gated step names a limit, and every limit is real ──
  SELECT string_agg(step_key, ', ') INTO v_missing
    FROM public.mos_step_rules
   WHERE capacity_key IS NOT NULL AND (daily_limit IS NULL OR daily_limit < 1);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'CONFORMANCE: capacity-gated step(s) with no usable limit: %', v_missing;
  END IF;

  -- A step with a limit but no capacity key is a limit that never applies —
  -- the gate in `mos_task_dispatch` short-circuits on `capacity_key IS NULL`.
  SELECT string_agg(step_key, ', ') INTO v_missing
    FROM public.mos_step_rules
   WHERE capacity_key IS NULL AND daily_limit IS NOT NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'CONFORMANCE: step(s) carry a daily_limit that can never apply: %', v_missing;
  END IF;

  -- ── 2. The design rate agrees across all three places that hold one ──────
  --
  -- mos_step_rules   the dispatcher's gate
  -- mos_role_load    the planner's per-role default
  -- mos_user_capacity the planner's per-user override (zero = not a producer)
  SELECT daily_limit INTO v_design FROM public.mos_step_rules WHERE step_key = 'design';
  SELECT daily_new_tasks INTO v_role FROM public.mos_role_load
   WHERE bucket = 'post' AND role_id = (SELECT id FROM public.roles WHERE key = 'mos_montage');
  IF v_design IS NOT NULL AND v_role IS NOT NULL AND v_design <> v_role THEN
    RAISE EXCEPTION
      'CONFORMANCE: design limit disagrees — dispatcher mos_step_rules=%, planner mos_role_load=%',
      v_design, v_role;
  END IF;

  -- A per-user override above the dispatcher's gate is the dangerous
  -- direction: the forecast books work the hand-out will then refuse.
  SELECT max(c.daily_slots) INTO v_user_min
    FROM public.mos_user_capacity c
   WHERE c.bucket = 'post' AND c.daily_slots > 0
     AND EXISTS (
       SELECT 1 FROM public.users u
         JOIN jsonb_array_elements(COALESCE(u.role_assignments, '[]'::jsonb)) e ON true
         JOIN public.roles r ON r.id::text = e->>'role_id'
        WHERE u.id = c.user_id AND r.key = 'mos_montage');
  IF v_design IS NOT NULL AND v_user_min IS NOT NULL AND v_user_min > v_design THEN
    RAISE EXCEPTION
      'CONFORMANCE: a montage holder is forecast at %/day but the dispatcher gate is %/day',
      v_user_min, v_design;
  END IF;

  SELECT daily_limit INTO v_writing FROM public.mos_step_rules WHERE step_key = 'writing';
  SELECT daily_new_tasks INTO v_role FROM public.mos_role_load
   WHERE bucket = 'post' AND role_id = (SELECT id FROM public.roles WHERE key = 'mos_writer');
  IF v_writing IS NOT NULL AND v_role IS NOT NULL AND v_writing <> v_role THEN
    RAISE EXCEPTION
      'CONFORMANCE: writing limit disagrees — dispatcher=%, planner=%', v_writing, v_role;
  END IF;

  -- ── 3. A ROW costs one unit per post, in both engines ────────────────────
  --
  -- The TypeScript side is `effortWeightsSameDay(memberCount)`; here it is
  -- `mos_task_units`, which must return the member count for a row and 1 for
  -- anything else. `engineConformance.test.ts` asserts the same numbers on the
  -- TypeScript side; the two together are the guarantee.
  IF to_regprocedure('public.mos_task_units(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'CONFORMANCE: mos_task_units is missing — the dispatcher cannot cost a task';
  END IF;
  IF public.mos_task_units('mos_content', gen_random_uuid()) <> 1 THEN
    RAISE EXCEPTION 'CONFORMANCE: a single content item must cost exactly 1 unit';
  END IF;
  -- A row with no members still costs 1, never 0: a zero-cost task would slip
  -- past every capacity gate no matter how many of them were queued.
  IF public.mos_task_units('mos_content_rows', gen_random_uuid()) < 1 THEN
    RAISE EXCEPTION 'CONFORMANCE: a row must never cost less than 1 unit';
  END IF;

  RAISE NOTICE 'CONFORMANCE OK — design=% writing=% (planner and dispatcher agree)', v_design, v_writing;
END $$;
