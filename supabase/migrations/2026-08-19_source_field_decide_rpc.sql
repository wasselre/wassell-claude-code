-- Phase 2 write path for the Market Automation cockpit: the operator's per-field
-- ruling. Upserts source_field_mappings (the decision authority) and resolves the
-- matching open schema_gap. Publishing stays a separate gated step, so a decision
-- alone never flows to market_listings. Audited by reviewer + decided_at.
-- Applied to prod (wassell-prod) 2026-08-19.
--
-- Enforces the table's own constraints up front: canonical_field only for
-- mapped_existing_field, a reason for the deciding statuses. Granted to
-- authenticated (the section is internal + unlinked; the owner isn't flagged
-- is_admin, and the publisher — not this RPC — is the gate to live data).

CREATE OR REPLACE FUNCTION public.source_field_decide(
  p_platform text,
  p_source_path text,
  p_status text,
  p_canonical_field text DEFAULT NULL,
  p_transformation text DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_contract text := 'v001';
  v_reviewer text := coalesce(nullif(auth.jwt() ->> 'email', ''), auth.uid()::text, 'operator');
  v_canon text := CASE WHEN p_status = 'mapped_existing_field' THEN nullif(p_canonical_field, '') END;
BEGIN
  IF p_status NOT IN ('mapped_existing_field','candidate_new_field','review_required',
                      'reviewed_source_specific','intentionally_ignored','technical_excluded') THEN
    RAISE EXCEPTION 'invalid status: %', p_status;
  END IF;
  IF p_status = 'mapped_existing_field' AND v_canon IS NULL THEN
    RAISE EXCEPTION 'a target column is required to map to an existing field';
  END IF;
  IF p_status IN ('mapped_existing_field','candidate_new_field','review_required')
     AND nullif(p_reason, '') IS NULL THEN
    RAISE EXCEPTION 'a reason is required for this decision';
  END IF;

  INSERT INTO public.source_field_mappings AS m
    (platform, source_path, contract_version, status, canonical_field, transformation,
     is_equivalent_to_existing, reviewer, reason, decided_at, created_at)
  VALUES
    (p_platform, p_source_path, v_contract, p_status, v_canon, nullif(p_transformation, ''),
     (p_status = 'mapped_existing_field'), v_reviewer, nullif(p_reason, ''), now(), now())
  ON CONFLICT (platform, source_path, contract_version) DO UPDATE
    SET status = EXCLUDED.status,
        canonical_field = EXCLUDED.canonical_field,
        transformation = EXCLUDED.transformation,
        is_equivalent_to_existing = EXCLUDED.is_equivalent_to_existing,
        reviewer = EXCLUDED.reviewer,
        reason = EXCLUDED.reason,
        decided_at = EXCLUDED.decided_at;

  UPDATE public.schema_gap_events
    SET status = 'resolved', resolved_at = now()
  WHERE platform = p_platform AND source_path = p_source_path
    AND contract_version = v_contract AND status = 'open';
END $$;

REVOKE ALL ON FUNCTION public.source_field_decide(text,text,text,text,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.source_field_decide(text,text,text,text,text,text) TO authenticated, service_role;
