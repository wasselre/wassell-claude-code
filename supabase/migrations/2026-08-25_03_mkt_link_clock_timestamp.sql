-- ============================================================================
-- Give the strategy-binding history a real ordering.
--
-- changed_at defaulted to now(), which is the TRANSACTION start time and is
-- therefore identical for every row written in one transaction. Two links
-- written together are then indistinguishable, and "ORDER BY changed_at DESC"
-- — what the API and the history panel both do — returns them in an arbitrary
-- order. For an append-only audit trail whose entire job is to say what
-- happened in what order, that is a real defect, not a cosmetic one.
--
-- clock_timestamp() reads the actual wall clock at INSERT, so rows written in
-- the same transaction are still strictly ordered.
--
-- Found by supabase/tests/mkt_plan_strategy_goal_test.sql, which binds a plan
-- twice and then rebases it inside one transaction and could not tell the three
-- resulting rows apart.
--
-- Existing rows are left exactly as they are: their timestamps are what was
-- recorded, and rewriting history to make a test tidier is precisely what this
-- table exists to prevent.
-- ============================================================================
BEGIN;

ALTER TABLE public.mkt_plan_strategy_links
  ALTER COLUMN changed_at SET DEFAULT clock_timestamp();

-- The measurement log has the same property and the same job.
ALTER TABLE public.mkt_goal_measurements
  ALTER COLUMN created_at SET DEFAULT clock_timestamp();

COMMIT;
