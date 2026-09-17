-- ============================================================================
-- Taking turns must survive a batch. 2026-09-17.
--
-- mos_task_dispatch stamped assigned_at with now(), which is the TRANSACTION
-- start time. The sweep hands out many tasks in one transaction, so every
-- hand-out got the same timestamp, "least recently assigned first" became a
-- tie, and the tie always broke to the same person (lowest uuid). Measured in a
-- rolled-back test with two designers and four designs: owner, sarah, owner,
-- owner — and the following revision went to the person who already had 3.
--
-- Fix: the dispatcher and the room check read clock_timestamp(), so each
-- hand-out is strictly later than the previous one and the rolling-window
-- count includes hand-outs made earlier in the same transaction.
-- ============================================================================

BEGIN;

DO $migrate$
DECLARE
  v_def text;
  v_old text;
BEGIN
  v_def := pg_get_functiondef('public.mos_task_dispatch(uuid, boolean)'::regprocedure);
  v_old := 'v_now     timestamptz := now();';
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING mos_task_dispatch v_now';
  END IF;
  EXECUTE replace(v_def, v_old, 'v_now     timestamptz := clock_timestamp();');

  v_def := pg_get_functiondef('public.mos_role_has_room(text, text, numeric)'::regprocedure);
  IF position('now()' IN v_def) = 0 THEN
    RAISE EXCEPTION 'MOS:MIGRATION_ANCHOR_MISSING mos_role_has_room now()';
  END IF;
  -- STABLE would let the planner fold clock_timestamp() once per statement;
  -- VOLATILE keeps it honest.
  v_def := replace(v_def, 'now()', 'clock_timestamp()');
  v_def := replace(v_def, ' STABLE ', ' VOLATILE ');
  EXECUTE v_def;
END $migrate$;

DO $$
BEGIN
  IF pg_get_functiondef('public.mos_task_dispatch(uuid, boolean)'::regprocedure) NOT LIKE '%clock_timestamp()%'
     OR pg_get_functiondef('public.mos_role_has_room(text, text, numeric)'::regprocedure) LIKE '%now()%' THEN
    RAISE EXCEPTION 'MOS:REAL_CLOCK_REWIRE_FAILED';
  END IF;
END $$;

COMMIT;
