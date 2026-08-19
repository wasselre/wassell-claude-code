-- ============================================================================
-- NEGATIVE CONTROL 1 — classify a genuinely 'filtered' model as 'all'.
--
-- Drops the mode preamble, so any model the caller may view is treated as
-- unrestricted. This is THE failure mode B2A.5 could have: the fast path says
-- "constant true" for a model whose visibility is actually per-record.
--
-- Personas 2222 (created_by filter), 3333 (matches-nothing filter) and 6666
-- (data-field filter) MUST gain rows. If they do not, the suite is not testing
-- the lemma the whole migration rests on.
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
   WHERE u.auth_uid = v_auth AND u.is_active = true LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF prof.is_admin THEN RETURN QUERY SELECT m.id FROM models m; RETURN; END IF;
  RETURN QUERY
  SELECT DISTINCT (e.v->>'model_id')::uuid
    FROM jsonb_array_elements(COALESCE(prof.model_permissions,'[]'::jsonb)) e(v)
   WHERE (e.v->>'model_id') IS NOT NULL
     AND (e.v->'permissions') @> to_jsonb('view'::text);
END;
$fn$;
