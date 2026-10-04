-- Drop the screen switches that control nothing (2026-10-04).
--
-- calendar / goals / campaigns / numbers / roles have no screen any more (their
-- routes redirect to /m/month, and the roles screen is gated by the manage_roles
-- capability, not a surface). The API's SURFACES list no longer carries them,
-- so their surface_access rows were dead weight on the permissions screen.
-- Rows are kept in _backup_mos_retired_roles_20261004 (source 'surface_access:dead').

BEGIN;

CREATE TABLE IF NOT EXISTS public._backup_mos_retired_roles_20261004 (
  source text NOT NULL,
  row_data jsonb NOT NULL
);
REVOKE ALL ON public._backup_mos_retired_roles_20261004 FROM anon, authenticated;

INSERT INTO public._backup_mos_retired_roles_20261004 (source, row_data)
SELECT 'surface_access:dead', to_jsonb(sa)
  FROM public.surface_access sa
 WHERE sa.surface_key IN ('calendar', 'goals', 'campaigns', 'numbers', 'roles');

DELETE FROM public.surface_access
 WHERE surface_key IN ('calendar', 'goals', 'campaigns', 'numbers', 'roles');

COMMIT;
