-- Access re-architecture · Phase 4 — let the Roles screen edit capabilities
--
-- Mirrors the surface_access write policies exactly: read is open (the matrix
-- renders for everyone), but granting/revoking a capability requires the
-- 'manage_roles' capability. The API 'capability_set' action writes directly
-- through the caller's RLS-scoped client (same posture as 'surface_set') — no
-- separate RPC. A grant is an INSERT of the (role, capability) row; a revoke is
-- a DELETE. There is no UPDATE — presence IS the grant.

BEGIN;

DROP POLICY IF EXISTS role_capabilities_ins ON public.role_capabilities;
CREATE POLICY role_capabilities_ins ON public.role_capabilities
  FOR INSERT TO authenticated
  WITH CHECK (public.wassell_mos_can('manage_roles'));

DROP POLICY IF EXISTS role_capabilities_del ON public.role_capabilities;
CREATE POLICY role_capabilities_del ON public.role_capabilities
  FOR DELETE TO authenticated
  USING (public.wassell_mos_can('manage_roles'));

COMMIT;
