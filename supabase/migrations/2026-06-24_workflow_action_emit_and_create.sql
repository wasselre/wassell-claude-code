-- ============================================================================
-- 2026-06-24: workflow_action_emit_and_create — ATOMIC create + filled emission
-- ----------------------------------------------------------------------------
-- Fixes the unfilled-reservation retry bug found in the controlled followups
-- proof (2026-06-24). The OLD flow did THREE separate round-trips from the JS
-- runner: workflow_action_emit_reserve (insert an UNFILLED emission as a lock)
-- → record_save_workflow (create) → workflow_action_emit_fill. A stall / lease
-- expiry / crash BETWEEN reserve and fill left an orphaned reservation
-- (created_record_id IS NULL). The retry's dedup then matched that orphan and
-- SKIPPED the create as success → the business effect was silently LOST.
--
-- This RPC collapses reserve+create+fill into ONE transaction so the emission
-- is ONLY EVER committed already-filled. There is no unfilled window: either the
-- whole tx commits (record created + emission filled, together) or it rolls back
-- (no record, no emission). Retry-safe AND crash-safe.
--
-- Algorithm:
--   1. FILLED-only dedup (fast path, no lock):
--        a. cross-run business key  (created_record_id IS NOT NULL)
--        b. same-run (run_id, action) (created_record_id IS NOT NULL)
--      → return the already-created record id, is_new=false. (Genuine dedup.)
--      An UNFILLED emission is NOT a dedup hit here — that was the bug.
--   2. Acquire the lock by INSERTing the emission row. Within THIS tx it is
--      momentarily unfilled, but no other tx can see it (uncommitted) and we
--      fill it before commit, so no unfilled row ever becomes visible.
--      On unique_violation, re-select the conflicting row:
--        * FILLED  → a concurrent winner already created the record ⇒ dedup,
--                    return its id WITHOUT creating (we have not created yet).
--        * UNFILLED → a pre-fix ORPHAN (or our own prior partial that rolled
--                    back leaving... no — rolled-back rows vanish; so this is a
--                    legacy orphan). RECLAIM it: we will fill it below.
--   3. Create the record via record_save_workflow (same tx).
--   4. Fill the emission (the row we inserted, or the orphan we reclaimed).
--      If the create RAISES, the whole tx (incl. the step-2 insert) rolls back
--      → no orphan, no record → the caller fails retryably and the job retries
--      onto a clean slate. A completed create_record action ALWAYS means the
--      record exists and created_record_id is filled.
--
-- Concurrency (two callers, same business effect): the unique indexes
-- (run_id,action) and (workflow_id,action,source,target,business_key) make the
-- emission INSERT the single gate. The loser blocks on the winner's uncommitted
-- row; when the winner commits, the loser's insert raises unique_violation →
-- re-selects the winner's FILLED emission → reuses it. Exactly one record, no
-- orphan, no unfilled row. If the winner rolls back, the loser's insert
-- succeeds and it creates → no lost effect.
--
-- This SUPERSEDES the runner's use of workflow_action_emit_reserve /
-- workflow_action_emit_fill for create_record. Those functions are left in
-- place (harmless, now unused by the runner) to keep this migration additive.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.workflow_action_emit_and_create(
  p_workflow_run_id  uuid,
  p_workflow_id      uuid,
  p_workflow_job_id  uuid,
  p_action_id        text,
  p_source_record_id uuid,
  p_target_model_id  uuid,
  p_business_key     text,
  p_new_record_id    uuid,
  p_data             jsonb,
  p_created_by       uuid,
  p_depth            integer,
  p_origin_run       uuid,
  p_parent_job       uuid
) RETURNS TABLE (created_record_id uuid, is_new boolean, deduped_by text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_emission uuid;
  v_created  uuid;
BEGIN
  -- 1) FILLED-only dedup (fast path). An unfilled match is NOT a dedup hit.
  IF p_business_key IS NOT NULL THEN
    SELECT e.id, e.created_record_id INTO v_emission, v_created
      FROM public.workflow_action_emissions e
     WHERE e.workflow_id = p_workflow_id
       AND e.action_id   = p_action_id
       AND e.source_record_id IS NOT DISTINCT FROM p_source_record_id
       AND e.target_model_id  IS NOT DISTINCT FROM p_target_model_id
       AND e.business_key = p_business_key
       AND e.created_record_id IS NOT NULL
     LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_created, false, 'business_key'::text; RETURN;
    END IF;
  END IF;

  SELECT e.id, e.created_record_id INTO v_emission, v_created
    FROM public.workflow_action_emissions e
   WHERE e.workflow_run_id = p_workflow_run_id
     AND e.action_id       = p_action_id
     AND e.created_record_id IS NOT NULL
   LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT v_created, false, 'same_run'::text; RETURN;
  END IF;

  -- 2) Acquire the lock via INSERT (filled before commit; see step 4).
  v_emission := NULL;
  BEGIN
    INSERT INTO public.workflow_action_emissions
      (workflow_run_id, workflow_id, workflow_job_id, action_id,
       source_record_id, target_model_id, business_key)
    VALUES
      (p_workflow_run_id, p_workflow_id, p_workflow_job_id, p_action_id,
       p_source_record_id, p_target_model_id, p_business_key)
    RETURNING id INTO v_emission;
  EXCEPTION WHEN unique_violation THEN
    -- Re-select the conflicting row (concurrent winner, or a legacy orphan).
    v_emission := NULL; v_created := NULL;
    IF p_business_key IS NOT NULL THEN
      SELECT e.id, e.created_record_id INTO v_emission, v_created
        FROM public.workflow_action_emissions e
       WHERE e.workflow_id = p_workflow_id
         AND e.action_id   = p_action_id
         AND e.source_record_id IS NOT DISTINCT FROM p_source_record_id
         AND e.target_model_id  IS NOT DISTINCT FROM p_target_model_id
         AND e.business_key = p_business_key
       LIMIT 1;
    END IF;
    IF v_emission IS NULL THEN
      SELECT e.id, e.created_record_id INTO v_emission, v_created
        FROM public.workflow_action_emissions e
       WHERE e.workflow_run_id = p_workflow_run_id
         AND e.action_id       = p_action_id
       LIMIT 1;
    END IF;

    IF v_emission IS NULL THEN
      -- Conflicting row vanished between the violation and the re-select
      -- (should not happen — emissions are not deleted in normal operation).
      -- Fail loudly so the job retries rather than silently doing nothing.
      RAISE EXCEPTION 'emit_and_create: unique_violation but no conflicting emission found (run=%, action=%)',
        p_workflow_run_id, p_action_id;
    END IF;

    IF v_created IS NOT NULL THEN
      -- FILLED concurrent winner ⇒ dedup, do NOT create (we have not created yet).
      RETURN QUERY SELECT v_created, false, 'filled_race'::text; RETURN;
    END IF;
    -- else: UNFILLED legacy orphan ⇒ reclaim v_emission and fill it in step 4.
  END;

  -- 3) Create the record (same tx as the emission lock above).
  PERFORM public.record_save_workflow(
    p_target_model_id, p_new_record_id, p_data, p_created_by, NULL,
    p_depth, p_origin_run, p_parent_job);

  -- 4) Fill the emission (newly inserted, or the reclaimed orphan). Adopt the
  --    current run/job for accurate provenance (safe: this run had no row for
  --    this action — step 1/2 found none and our insert either won or hit the
  --    business index from a different run).
  UPDATE public.workflow_action_emissions
     SET created_record_id = p_new_record_id,
         workflow_run_id   = p_workflow_run_id,
         workflow_job_id   = p_workflow_job_id
   WHERE id = v_emission;

  RETURN QUERY SELECT p_new_record_id, true, NULL::text;
END $$;

REVOKE ALL ON FUNCTION public.workflow_action_emit_and_create(uuid, uuid, uuid, text, uuid, uuid, text, uuid, jsonb, uuid, integer, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_action_emit_and_create(uuid, uuid, uuid, text, uuid, uuid, text, uuid, jsonb, uuid, integer, uuid, uuid)
  TO service_role;

COMMIT;

-- ── DOWN ────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.workflow_action_emit_and_create(uuid, uuid, uuid, text, uuid, uuid, text, uuid, jsonb, uuid, integer, uuid, uuid);
