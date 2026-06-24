-- ============================================================================
-- 2026-06-23: workflow_action_emit_reserve / _fill — atomic create dedup
-- ----------------------------------------------------------------------------
-- Reservation-before-create. The runner must reserve the emission row BEFORE it
-- creates the record, so that under a concurrent race (two workers, same
-- business effect) the unique indexes pick ONE winner before either side
-- creates a record. Doing this as round-trips in JS can't be atomic across the
-- TWO unique indexes (same-run + cross-run business), so it's one plpgsql call:
--
--   reserve(run, workflow, job, action, source_record, target_model, business_key)
--     1. cross-run business dedup  → if a prior emission for this business key
--        exists, return it (do NOT create).
--     2. same-run dedup            → if this run already emitted this action,
--        return it (retry of the same run).
--     3. otherwise INSERT a reservation (created_record_id NULL = the lock) and
--        return is_new=true → the caller creates the record, then calls _fill.
--     On a unique_violation (another tx won between our SELECT and INSERT),
--     re-select the winner and return it as a dedup hit. So exactly one caller
--     ever gets is_new=true for a given business effect.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.workflow_action_emit_reserve(
  p_workflow_run_id  uuid,
  p_workflow_id      uuid,
  p_workflow_job_id  uuid,
  p_action_id        text,
  p_source_record_id uuid,
  p_target_model_id  uuid,
  p_business_key     text
) RETURNS TABLE (emission_id uuid, created_record_id uuid, is_new boolean, deduped_by text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id      uuid;
  v_created uuid;
BEGIN
  -- 1) Cross-run business dedup (the real duplicate-effect guard).
  IF p_business_key IS NOT NULL THEN
    SELECT e.id, e.created_record_id INTO v_id, v_created
      FROM public.workflow_action_emissions e
     WHERE e.workflow_id = p_workflow_id
       AND e.action_id   = p_action_id
       AND e.source_record_id IS NOT DISTINCT FROM p_source_record_id
       AND e.target_model_id  IS NOT DISTINCT FROM p_target_model_id
       AND e.business_key = p_business_key
     LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT v_id, v_created, false, 'business_key'::text; RETURN;
    END IF;
  END IF;

  -- 2) Same-run dedup (retry of the same reused run).
  SELECT e.id, e.created_record_id INTO v_id, v_created
    FROM public.workflow_action_emissions e
   WHERE e.workflow_run_id = p_workflow_run_id AND e.action_id = p_action_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_id, v_created, false, 'same_run'::text; RETURN;
  END IF;

  -- 3) Reserve. created_record_id stays NULL until _fill — the row itself is the
  --    lock. A concurrent winner trips one of the unique indexes ⇒ we re-select.
  BEGIN
    INSERT INTO public.workflow_action_emissions
      (workflow_run_id, workflow_id, workflow_job_id, action_id,
       source_record_id, target_model_id, business_key)
    VALUES
      (p_workflow_run_id, p_workflow_id, p_workflow_job_id, p_action_id,
       p_source_record_id, p_target_model_id, p_business_key)
    RETURNING id INTO v_id;
    RETURN QUERY SELECT v_id, NULL::uuid, true, NULL::text; RETURN;
  EXCEPTION WHEN unique_violation THEN
    IF p_business_key IS NOT NULL THEN
      SELECT e.id, e.created_record_id INTO v_id, v_created
        FROM public.workflow_action_emissions e
       WHERE e.workflow_id = p_workflow_id
         AND e.action_id   = p_action_id
         AND e.source_record_id IS NOT DISTINCT FROM p_source_record_id
         AND e.target_model_id  IS NOT DISTINCT FROM p_target_model_id
         AND e.business_key = p_business_key
       LIMIT 1;
      IF FOUND THEN
        RETURN QUERY SELECT v_id, v_created, false, 'business_key_race'::text; RETURN;
      END IF;
    END IF;
    SELECT e.id, e.created_record_id INTO v_id, v_created
      FROM public.workflow_action_emissions e
     WHERE e.workflow_run_id = p_workflow_run_id AND e.action_id = p_action_id;
    RETURN QUERY SELECT v_id, v_created, false, 'same_run_race'::text; RETURN;
  END;
END $$;

REVOKE ALL ON FUNCTION public.workflow_action_emit_reserve(uuid, uuid, uuid, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_action_emit_reserve(uuid, uuid, uuid, text, uuid, uuid, text) TO service_role;

-- Fill the reservation with the created record id after the create succeeds.
CREATE OR REPLACE FUNCTION public.workflow_action_emit_fill(
  p_emission_id uuid,
  p_created_record_id uuid
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.workflow_action_emissions
     SET created_record_id = p_created_record_id
   WHERE id = p_emission_id;
$$;

REVOKE ALL ON FUNCTION public.workflow_action_emit_fill(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_action_emit_fill(uuid, uuid) TO service_role;

COMMIT;
