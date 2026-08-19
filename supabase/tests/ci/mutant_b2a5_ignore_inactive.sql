-- ============================================================================
-- NEGATIVE CONTROL 3 — ignore users.is_active.
--
-- A deactivated account keeps its profile's model list. wassell_user_has_action
-- and wassell_record_passes_scope both filter on is_active, so the fast path
-- must too.
--
-- Persona 5555 (deactivated, but attached to the permissive 1111 profile) MUST
-- gain rows. This is the closest analogue to B2A.1, which reached production
-- because a fixture never exercised a revoked identity.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.wassell_my_view_scope_all_models()
RETURNS TABLE (model_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $fn$
DECLARE
  v_auth uuid := (SELECT auth.uid());
  prof   profiles%ROWTYPE;
BEGIN
  IF v_auth IS NULL THEN RETURN; END IF;
  SELECT p.* INTO prof FROM profiles p JOIN users u ON u.profile_id = p.id
   WHERE u.auth_uid = v_auth LIMIT 1;                      -- is_active dropped
  IF NOT FOUND THEN RETURN; END IF;
  IF prof.is_admin THEN RETURN QUERY SELECT m.id FROM models m; RETURN; END IF;
  RETURN QUERY
  SELECT DISTINCT (e.v->>'model_id')::uuid
    FROM jsonb_array_elements(COALESCE(prof.model_permissions,'[]'::jsonb)) e(v)
   WHERE (e.v->>'model_id') IS NOT NULL
     AND (e.v->'permissions') @> to_jsonb('view'::text)
     AND ( e.v->'view_scope' IS NULL
        OR e.v->'view_scope'->>'mode' IS DISTINCT FROM 'filtered'
        OR jsonb_array_length(COALESCE(e.v->'view_scope'->'conditions','[]'::jsonb)) = 0 );
END;
$fn$;
