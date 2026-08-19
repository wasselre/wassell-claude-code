-- ============================================================================
-- Phase 3 · B2A.6 — the second caller of wassell_can_view_record
--
-- Follow-up to B2A.5 (2026-08-19_01). Same root cause, different call site.
--
-- ── WHY B2A.5 DID NOT FIX THIS ─────────────────────────────────────────────
-- B2A.5 hoisted the per-model scope class into the `records_view` POLICY. B4's
-- `wassell_my_record_derived_file_ids()` calls `wassell_can_view_record`
-- DIRECTLY, not through that policy, so it got none of the benefit — and
-- because it is invoked once per statement by both `files_select` and
-- `file_links_select`, every statement that touches either table paid it.
--
-- Measured on production 2026-08-19, after B2A.5 was live:
--
--   the helper, called alone               1,453 ms
--   full file_links scan                   1,358 ms   <- essentially just the helper
--   files scan                             1,410 ms   <- essentially just the helper
--
-- ── THE OBVIOUS FIX IS A 2.3x PESSIMISATION — MEASURED, NOT ASSUMED ────────
-- The natural move is to paste B2A.5's term into the helper's WHERE clause:
--
--   AND ( r.model_id IN (SELECT s.model_id FROM wassell_my_view_scope_all_models() s)
--         OR wassell_can_view_record((SELECT auth.uid()), r.*) )
--
-- That makes it SLOWER: 731 ms -> 1,693 ms (medians of 4, tight variance).
--
-- EXPLAIN says why, and it is worth writing down because it is not obvious.
-- The ORIGINAL query gets a Nested Loop with **Memoize** keyed on
-- (record_id, model_id): 9,856 links, 3,988 cache hits, so
-- `wassell_can_view_record` runs 5,868 times — once per DISTINCT linked record,
-- never for a record no link points at. Adding the OR term makes the qual look
-- cheap enough that the planner switches to a Hash Join whose inner side is a
-- **Seq Scan over all 39,975 records**, filtering 24,777 of them — most
-- referenced by no link at all. The fast path is bought by discarding a far
-- better join shape.
--
-- Lesson, same family as the one already recorded next to the b2a4 CI job
-- (hashed SubPlans are evaluated after ordinary quals regardless of declared
-- cost): adding a cheap-looking disjunct can cost more than it saves by
-- changing the PLAN. Measure the shape, not just the predicate.
--
-- ── WHAT THIS DOES INSTEAD: SPLIT, DO NOT DISJOIN ──────────────────────────
-- Partition the links by model instead of ORing per row, so each branch keeps
-- the plan it wants:
--
--   branch 1  links whose model is unrestricted for this caller
--             -> visibility is decided; only record EXISTENCE is still needed,
--                so the join runs with NO function call at all
--   branch 2  every other link
--             -> unchanged per-row check, but only over the residue
--
-- On production, for the caller measured, branch 2 sees 3 links out of 9,856
-- and calls `wassell_can_view_record` TWICE, down from 5,868.
--
--   caller       before      after
--   31621e58     882.8 ms    24.0 ms
--   98e5f23c     828.7 ms    24.2 ms
--   ad5e1e47   1,155.0 ms    25.1 ms
--   ae48de5f     587.4 ms     1.6 ms
--   b30d0678   1,109.5 ms    25.7 ms
--   d04de234       0.7 ms     0.1 ms
--   e350f736   1,321.7 ms    25.8 ms
--
-- Reach unchanged: the returned file-id set is byte-identical for all 7 users,
-- +0 gained / -0 lost, compared by sorted-id fingerprint.
--
-- ── EQUIVALENCE ────────────────────────────────────────────────────────────
-- This is a PARTITION, not B2A.5's `FASTPATH OR ORIGINAL`, so the argument is
-- slightly different — but it rests on exactly the same lemma:
--
--     scope_class(caller, model) = 'all'  =>  wassell_can_view_record is TRUE
--                                             for every row of that model
--
--   * model in the set     -> branch 1 admits the link iff the record exists.
--                             The original admitted it iff the record existed
--                             AND can_view_record, which the lemma makes true.
--   * model not in the set -> branch 2 is the original predicate verbatim.
--
-- The two branches cover the link set exactly once, so no link can be dropped
-- and none double-counted (UNION dedupes anyway). As with B2A.5, the only
-- reachable defect is a widening, and only if the lemma fails.
--
-- `WHERE s.model_id IS NOT NULL` in the CTE is not decoration: branch 2 uses
-- `NOT IN`, and a single NULL in that set would make the predicate NULL for
-- every row and silently NARROW the result to branch 1 alone. The function
-- cannot return NULL today; this makes it impossible for it to start mattering.
--
-- ── THE ZERO-PERMISSION GUARD, AND WHY IT IS WRITTEN IN TWO STATEMENTS ─────
-- A caller with no `view` action on ANY model that appears in `file_links` can
-- never be returned a single row, because `wassell_can_view_record` requires
-- `wassell_user_has_action(..., 'view')`. Without an explicit guard such a
-- caller falls into branch 2 with an empty `allm` (so `NOT IN` admits
-- everything) and pays the full scan to produce nothing — measured 587 ms for
-- `ae48de5f`, whose profile carries eight `model_permissions` entries pointing
-- at models that no longer exist.
--
-- The guard MUST be two statements. Written as one query:
--
--   EXISTS (SELECT 1 FROM (SELECT DISTINCT l.model_id FROM file_links l) lm
--            WHERE wassell_user_has_action(v_auth, lm.model_id, 'view'))
--
-- the planner pushes the filter BELOW the DISTINCT and evaluates the function
-- on all 9,856 rows instead of the 10 distinct models — 389 ms instead of 2 ms,
-- confirmed by EXPLAIN (`Rows Removed by Filter: 9856`). Collecting the
-- distinct models into an array first puts a statement boundary in the way, so
-- there is nothing to push through. Do not "simplify" this back into one query.
--
-- Rollback: supabase/rollback/2026-08-19_02_derived_file_ids_fast_path_down.sql
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_my_record_derived_file_ids()
RETURNS TABLE (file_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_auth        uuid := (SELECT auth.uid());
  v_link_models uuid[];
BEGIN
  -- B4's kill switch and the identity invariant, unchanged in meaning. They
  -- were conjuncts of the old WHERE clause; as early returns they also skip the
  -- work below, which is the point.
  IF NOT public.wassell_file_derived_access_enabled() THEN RETURN; END IF;
  IF public.wassell_app_user_id(v_auth) IS NULL THEN RETURN; END IF;

  -- Zero-permission guard. Two statements on purpose — see the header.
  SELECT array_agg(DISTINCT l.model_id) INTO v_link_models FROM public.file_links l;
  IF v_link_models IS NULL THEN RETURN; END IF;          -- no edges at all
  IF NOT EXISTS (SELECT 1 FROM unnest(v_link_models) m(mid)
                  WHERE public.wassell_user_has_action(v_auth, m.mid, 'view')) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH allm AS MATERIALIZED (
    SELECT s.model_id
      FROM public.wassell_my_view_scope_all_models() s
     WHERE s.model_id IS NOT NULL                        -- load-bearing, see header
  )
  -- branch 1: model is unrestricted for this caller, so only existence matters
  SELECT l.file_id
    FROM public.file_links l
    JOIN public.records r ON r.id = l.record_id AND r.model_id = l.model_id
   WHERE l.model_id IN (SELECT model_id FROM allm)
  UNION
  -- branch 2: the residue, checked exactly as before
  SELECT l.file_id
    FROM public.file_links l
    JOIN public.records r ON r.id = l.record_id AND r.model_id = l.model_id
   WHERE l.model_id NOT IN (SELECT model_id FROM allm)
     AND public.wassell_can_view_record(v_auth, r.*);
END;
$fn$;

COMMENT ON FUNCTION public.wassell_my_record_derived_file_ids() IS
  'B4 record-derived file access, with B2A.6''s model partition. Invoked once per statement by files_select AND file_links_select, so its cost is paid by every read of either table. Do NOT rewrite the partition as a single OR predicate: measured 2.3x SLOWER on production because it costs the Memoize-backed nested loop. Do NOT collapse the two-statement zero-permission guard into one query: the planner pushes the filter below the DISTINCT.';

REVOKE ALL ON FUNCTION public.wassell_my_record_derived_file_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wassell_my_record_derived_file_ids() TO authenticated;

COMMIT;
