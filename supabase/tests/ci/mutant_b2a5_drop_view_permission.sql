-- ============================================================================
-- NEGATIVE CONTROL 2 — drop the 'view' permission check.
--
-- Any model listed in model_permissions is treated as unrestricted-viewable,
-- even one the caller only holds 'edit'/'delete' on.
--
-- Persona 4444 (edit + delete, NO view) MUST gain rows. That persona sees zero
-- records under the real rule, so any gain is a clean, unambiguous leak.
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
     AND ( e.v->'view_scope' IS NULL
        OR e.v->'view_scope'->>'mode' IS DISTINCT FROM 'filtered'
        OR jsonb_array_length(COALESCE(e.v->'view_scope'->'conditions','[]'::jsonb)) = 0 );
END;
$fn$;
