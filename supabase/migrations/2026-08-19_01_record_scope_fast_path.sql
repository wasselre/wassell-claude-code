-- ============================================================================
-- Phase 3 · B2A.5 — hoist the per-model view-scope class out of the per-row
--                   record-visibility check
--
-- Fixes https://github.com/wasselre/wassell-claude-code/issues/32.
--
-- ── THE MEASUREMENT (production, read-only, 2026-08-19) ────────────────────
-- `records_view` is `wassell_can_view_record(auth.uid(), records.*)`, evaluated
-- once per candidate row. It costs 0.118 ms against 0.0014 ms for the bare row
-- it guards — about 85x. Anything that reads records in BULK pays that.
--
-- `file_links_select` is such a reader: its record half is
-- `EXISTS (SELECT 1 FROM unified_records ur WHERE ur.id = ... AND ur.model_id = ...)`,
-- and `unified_records` is security_invoker, so every candidate edge lands on
-- this policy. Measured over the full 9,856-edge table:
--
--   caller       record half BEFORE
--   admin                444.2 ms
--   e350f736             750.6 ms
--   ad5e1e47             633.8 ms
--   b30d0678             636.6 ms
--
-- That is ~2.5 scans inside `business_files_search`, which is why it misses its
-- 300 ms budget at 1.5-2.9 s. B2 is merely the first feature to read links in
-- bulk; B5's "Used in" panel and B6's linking UI hit the identical wall. So the
-- fix belongs HERE, in the authorization layer, not inside the search function.
--
-- ── WHY THE PER-ROW CALL IS WASTED WORK ────────────────────────────────────
-- `wassell_can_view_record` = `wassell_user_has_action(uid, model_id, 'view')`
-- AND `wassell_record_passes_scope(rec, uid, 'view')`. Both re-read the caller's
-- user + profile row on EVERY call, and for most (caller, model) pairs the
-- answer does not depend on the record at all — it is decided entirely by the
-- profile's `model_permissions` entry for that model.
--
-- Measured on production, all 7 users x all 49 models = 343 pairs:
--   'all'      315      -- constant TRUE  for every row of that model
--   'none'      26      -- constant FALSE for every row of that model
--   'filtered'   2      -- genuinely per-row (the `tasks` model)
--
-- 341 of 343 pairs are constant. The old policy spent 0.118 ms per row
-- recomputing a constant.
--
-- ── MATERIALISE THE INPUTS, NOT THE ANSWER ─────────────────────────────────
-- This is the distinction that separated B2A.4 from the abandoned B2A.3, and it
-- is the explicit trap flagged on the issue: the obvious move is to hoist the
-- caller's visible-RECORD set once per statement. Do not. This caller can see
-- 334,585 records; materialising that set costs far more than the scan it
-- replaces, which is exactly how B2A.3 made point lookups 59x slower.
--
-- The INPUT is tiny: one scope class per MODEL. 49 rows, derived from a single
-- profile read. So we hoist that, and the per-row cost collapses to a hash
-- probe on `model_id`.
--
-- ── ONE PROFILE READ, NOT 49 ───────────────────────────────────────────────
-- `wassell_view_scope_class(uid, model_id)` already exists (2026-07-13) and is
-- the authority this function must agree with — but it re-reads the profile on
-- every call. Building the set by calling it 49 times measured 4.0-5.5 ms, and
-- a statement that reads ONE record would pay all of it to save 0.118 ms. That
-- is the B2A.3 failure mode in miniature. Reading the profile ONCE and deriving
-- all 49 classes from `model_permissions` measures 0.1 ms — 45x cheaper, and
-- cheap enough that point lookups do not regress.
--
-- Verified on production: this function's classification agrees with
-- `wassell_view_scope_class` on all 343 (user, model) pairs, +0/-0.
--
-- ── WHY THIS CANNOT NARROW ANYONE'S REACH ──────────────────────────────────
-- The new predicate is `FASTPATH OR ORIGINAL`. The original term is still
-- there, unchanged, so every row visible before is visible now, structurally —
-- no measurement required. The ONLY possible defect is a WIDENING, and that
-- reduces to a single lemma:
--
--     scope_class(caller, model) = 'all'  =>  wassell_can_view_record is TRUE
--                                             for every row of that model
--
-- which is what the CI suite's mutants attack directly. Proven on production
-- for all 7 users over all 39,972 records: sorted-id fingerprints byte-identical,
-- +0 gained / -0 lost, including the two users whose `tasks` scope is genuinely
-- 'filtered' (5-of-16 and 0-of-16 visible — a partial, so the filtered branch is
-- not vacuous).
--
--   caller       record half BEFORE   AFTER    rows (before = after)
--   admin              444.2 ms      26.3 ms    9,831
--   e350f736           750.6 ms      28.1 ms    9,828
--   ad5e1e47           633.8 ms      27.5 ms    9,818
--   b30d0678           636.6 ms      29.1 ms    9,651
--
-- ── THE SHAPE IS LOAD-BEARING: UNCORRELATED `IN`, NOT A CORRELATED `EXISTS` ─
-- `model_id IN (SELECT ... FROM srf())` is uncorrelated, so the planner builds
-- it as a hashed SubPlan evaluated ONCE per statement — the same shape
-- `files_select` has used since B2A. Written instead as
-- `EXISTS (SELECT 1 FROM srf() s WHERE s.model_id = records.model_id AND ...)`
-- the subquery becomes CORRELATED, the hash is lost, and the set-returning
-- function is re-executed for every row — strictly worse than what it replaces.
-- If you rewrite this predicate, keep the subquery uncorrelated.
--
-- ── SCOPE ──────────────────────────────────────────────────────────────────
-- Frozen models carry their own `frozen_view` policies (generated by
-- `regenerate_frozen_model_artifacts`) with the same per-row shape. They are
-- untouched here: exactly 1 of 9,856 edges targets a frozen model today, so
-- there is nothing measured to fix. If frozen-model links ever grow, that is a
-- separate batch with its own measurement — do not assume this migration
-- covered it.
--
-- Rollback: supabase/rollback/2026-08-19_01_record_scope_fast_path_down.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The hoisted input set: models this caller may view with an unrestricted
--    view scope, i.e. the models for which the per-row check is constant TRUE.
--
--    CALLER-SCOPED, taking no target user, per the posture set by
--    2026-08-17_01_scope_authz_helpers.sql: a SECURITY DEFINER set-returning
--    function is published at /rest/v1/rpc/<name>, so it must be safe to call
--    directly. It returns only the caller's OWN model ids — the same list the
--    SPA already receives in its bootstrap — and returns NOTHING for an
--    unauthenticated, unknown, or deactivated caller.
--
--    Deliberately NO service_role branch, unlike wassell_view_scope_class.
--    That function returns 'all' for a null auth uid bearing service_role
--    claims (added so server-side callers are not scoped to nothing). Here the
--    same branch would be a widening: wassell_can_view_record(NULL, ...) is
--    FALSE, so the fast path must be empty when auth.uid() is null. service_role
--    bypasses RLS outright and never reaches this policy anyway.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.wassell_my_view_scope_all_models()
RETURNS TABLE (model_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_auth uuid := (SELECT auth.uid());
  prof   profiles%ROWTYPE;
BEGIN
  IF v_auth IS NULL THEN RETURN; END IF;

  SELECT p.* INTO prof
    FROM profiles p
    JOIN users u ON u.profile_id = p.id
   WHERE u.auth_uid = v_auth AND u.is_active = true
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  -- Mirrors wassell_user_has_action / wassell_record_passes_scope: an admin
  -- short-circuits to true for every model before model_permissions is read.
  IF prof.is_admin THEN
    RETURN QUERY SELECT m.id FROM models m;
    RETURN;
  END IF;

  -- One entry per model. Both authority functions pick their entry with
  -- `... WHERE (mp->>'model_id')::uuid = <model> LIMIT 1` over
  -- jsonb_array_elements, i.e. the FIRST array element for that model wins.
  -- DISTINCT ON + ORDER BY ordinality reproduces that exactly, so a profile
  -- carrying duplicate entries for one model classifies the same way here as
  -- it evaluates there. (Production has no duplicates today; this is why it
  -- cannot start mattering silently.)
  RETURN QUERY
  WITH first_entry AS (
    SELECT DISTINCT ON ((e.v->>'model_id')::uuid)
           (e.v->>'model_id')::uuid AS mid,
           e.v                      AS perm
      FROM jsonb_array_elements(COALESCE(prof.model_permissions, '[]'::jsonb))
           WITH ORDINALITY e(v, ord)
     WHERE (e.v->>'model_id') IS NOT NULL
     ORDER BY (e.v->>'model_id')::uuid, e.ord
  )
  SELECT fe.mid
    FROM first_entry fe
   WHERE (fe.perm->'permissions') @> to_jsonb('view'::text)
     AND (
          -- The mode preamble of wassell_record_passes_scope, branch for
          -- branch: no rule, mode='all', any mode that is not 'filtered', or
          -- 'filtered' carrying zero conditions, all return true outright.
             fe.perm->'view_scope' IS NULL
          OR fe.perm->'view_scope'->>'mode' IS DISTINCT FROM 'filtered'
          OR jsonb_array_length(COALESCE(fe.perm->'view_scope'->'conditions', '[]'::jsonb)) = 0
         );
END;
$fn$;

COMMENT ON FUNCTION public.wassell_my_view_scope_all_models() IS
  'Models the CURRENT caller may view with an unrestricted view scope, i.e. where wassell_can_view_record is constant TRUE for every row. Hoisted once per statement by records_view as a hashed SubPlan. MUST agree with wassell_view_scope_class(uid, model_id) = all — if you change wassell_user_has_action or the mode preamble of wassell_record_passes_scope, change all three together.';

REVOKE ALL ON FUNCTION public.wassell_my_view_scope_all_models() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.wassell_my_view_scope_all_models() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. The policy. FASTPATH OR ORIGINAL — the original term is preserved
--    verbatim, so narrowing is structurally impossible and the only failure
--    mode left is a widening of the fast path.
--
--    Note the IN (SELECT ...) must stay UNCORRELATED (see header).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS records_view ON public.records;
CREATE POLICY records_view ON public.records
  FOR SELECT TO authenticated
  USING (
       records.model_id IN (SELECT s.model_id
                              FROM public.wassell_my_view_scope_all_models() s)
    OR public.wassell_can_view_record((SELECT auth.uid()), records.*)
  );

COMMIT;
