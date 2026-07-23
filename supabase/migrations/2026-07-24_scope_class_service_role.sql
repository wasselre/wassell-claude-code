-- ──────────────────────────────────────────────────────────────────────
-- wassell_view_scope_class: service-role callers get 'all' (2026-07-24)
--
-- The fast-path RPCs (wassell_model_records_json / wassell_market_candidates_json)
-- gate on wassell_view_scope_class(auth.uid(), model). A SERVICE-ROLE caller has
-- auth.uid() = NULL, which returned 'none' — so the RPC returned [] while a
-- direct unified_records read (RLS-bypassed) would have returned every row.
-- Found live 2026-07-24: the Retell agent-tools endpoint's find_matching_projects
-- (service client → findMatchingProjects → loadModelRecords → this RPC) always
-- saw 0 candidates.
--
-- Fix: NULL uid + JWT role 'service_role' → 'all'. Not a security change —
-- service_role already bypasses RLS on every direct read; this just makes the
-- fast-path RPCs agree. Anon callers (NULL uid, role 'anon') still get 'none'.
-- ──────────────────────────────────────────────────────────────────────

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_view_scope_class(
  auth_user_id uuid, the_model_id uuid
) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  prof profiles%ROWTYPE;
  model_perm jsonb;
  rule jsonb;
BEGIN
  IF auth_user_id IS NULL THEN
    -- Service-role caller (RLS-bypassing key): full visibility, same as its
    -- direct table reads. Anything else with no uid stays locked out.
    IF (NULLIF(current_setting('request.jwt.claims', true), ''))::jsonb->>'role' = 'service_role' THEN
      RETURN 'all';
    END IF;
    RETURN 'none';
  END IF;
  SELECT p.* INTO prof FROM profiles p
    JOIN users u ON u.profile_id = p.id
   WHERE u.auth_uid = auth_user_id AND u.is_active = true LIMIT 1;
  IF NOT FOUND THEN RETURN 'none'; END IF;
  IF prof.is_admin THEN RETURN 'all'; END IF;
  SELECT mp INTO model_perm FROM jsonb_array_elements(prof.model_permissions) mp
    WHERE (mp->>'model_id')::uuid = the_model_id LIMIT 1;
  IF model_perm IS NULL THEN RETURN 'none'; END IF;
  IF NOT ((model_perm->'permissions') @> to_jsonb('view'::text)) THEN RETURN 'none'; END IF;
  rule := model_perm -> 'view_scope';
  IF rule IS NULL THEN RETURN 'all'; END IF;
  IF rule->>'mode' = 'all' THEN RETURN 'all'; END IF;
  IF rule->>'mode' <> 'filtered' THEN RETURN 'all'; END IF;
  IF jsonb_array_length(COALESCE(rule->'conditions', '[]'::jsonb)) = 0 THEN RETURN 'all'; END IF;
  RETURN 'filtered';
END $$;

COMMIT;
