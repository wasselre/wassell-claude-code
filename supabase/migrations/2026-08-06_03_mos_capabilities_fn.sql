-- Access re-architecture · Phase 2 — the caller's capability set, server-side
--
-- Twin of wassell_mos_roles(): returns the UNION of capabilities the caller
-- holds, resolved from the SAME role_capabilities table wassell_mos_can reads.
-- The bootstrap ships this array to the client so the browser stops keeping a
-- hand-maintained MATRIX copy — one source of truth, no drift. Admin = every
-- capability in the registry; a person with no marketing role = read-only floor.

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_mos_capabilities(
  p_auth_uid uuid DEFAULT auth.uid()
)
RETURNS text[]
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_auth_uid IS NULL THEN ARRAY[]::text[]
    -- App admins are marketing superusers: every capability the registry knows.
    WHEN public.wassell_is_admin(p_auth_uid)
      THEN COALESCE((SELECT array_agg(DISTINCT capability) FROM public.role_capabilities), ARRAY[]::text[])
    ELSE COALESCE(
      (SELECT array_agg(DISTINCT rc.capability)
         FROM unnest(public.wassell_mos_roles(p_auth_uid)) AS h(role_key)
         JOIN public.roles r ON r.key = 'mos_' || h.role_key
         JOIN public.role_capabilities rc ON rc.role_id = r.id),
      -- No marketing role → the viewer read-floor (mirrors wassell_mos_can).
      CASE WHEN 'viewer' = ANY (public.wassell_mos_roles(p_auth_uid))
           THEN ARRAY['read'] ELSE ARRAY[]::text[] END
    )
  END;
$function$;

GRANT EXECUTE ON FUNCTION public.wassell_mos_capabilities(uuid) TO authenticated, service_role;

COMMIT;
