-- Access re-architecture · Phase 0 — capabilities become DATA (ship dark)
--
-- Today the Marketing OS capability table lives in TWO hand-synced copies:
--   1. the SQL CASE inside wassell_mos_can()  (drives RLS)
--   2. the client MATRIX in MarketingWorkspace.tsx  (drives which buttons show)
-- and a scattering of hardcoded `role === 'ceo'` checks in components that
-- bypass both. This migration introduces the ONE data source that replaces the
-- CASE (Phase 1 rewrites the function to read it) and, later, the client copy
-- (Phase 2 ships it via bootstrap). Nothing reads this table yet — it is seeded
-- to reproduce the current CASE EXACTLY, so applying it is behaviour-neutral.
--
-- `domain` on roles namespaces the shared registry (sales vs marketing) so the
-- two "مدير التسويق" rows stop colliding in the pickers (Phase 5 consumes it).

BEGIN;

-- 1. Namespace the shared roles registry ---------------------------------
ALTER TABLE public.roles
  ADD COLUMN IF NOT EXISTS domain text NOT NULL DEFAULT 'sales';

-- Marketing OS roles carry the 'mos_' key prefix; everything else is a
-- sales-domain role (used for record scope field_values). No 'intel' rows
-- exist yet (Marketing-Intelligence stores its role as text in mkt_role_grants;
-- Phase 5 folds it in).
UPDATE public.roles
  SET domain = 'marketing'
  WHERE key LIKE 'mos\_%' ESCAPE '\';

ALTER TABLE public.roles
  DROP CONSTRAINT IF EXISTS roles_domain_chk;
ALTER TABLE public.roles
  ADD CONSTRAINT roles_domain_chk CHECK (domain IN ('sales', 'marketing', 'intel'));

-- 2. The capability grant table ------------------------------------------
-- Presence of a (role_id, capability) row = that role is granted that
-- capability. Deleting the row revokes it. This is the marketing twin of the
-- sales `profiles.model_permissions` JSONB — permissions as editable data.
CREATE TABLE IF NOT EXISTS public.role_capabilities (
  role_id    uuid NOT NULL REFERENCES public.roles(id) ON DELETE CASCADE,
  capability text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, capability)
);

-- Read-only to every authenticated user (capabilities are not secret; the
-- Roles screen renders the matrix). Writes go ONLY through the SECURITY DEFINER
-- RPC added in Phase 4 (self-authorized by 'manage_roles') — no write policy
-- here means no direct client writes, same posture as surface_access.
ALTER TABLE public.role_capabilities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_capabilities_read ON public.role_capabilities;
CREATE POLICY role_capabilities_read ON public.role_capabilities
  FOR SELECT TO authenticated USING (true);

-- 3. Seed — EXACT reproduction of the current wassell_mos_can CASE ---------
-- The five grantable marketing roles. 'administrator' is not a row here (it is
-- the app-admin superuser bypass, kept in the function); the 'viewer' floor
-- (read-only for a person with no marketing role) is likewise kept in the
-- function. marketing_manager gets the full registry (it is "full marketing").
--
-- The three view_* capabilities are NEW and inert until Phase 3 wires the
-- component checks to them; they are seeded to reproduce today's behaviour
-- (only the CEO loses the content-body tab, the activity rail and the
-- version-compare button — every other role keeps them).
INSERT INTO public.role_capabilities (role_id, capability)
SELECT r.id, cap
FROM (VALUES
  ('mos_marketing_manager', ARRAY[
      'read','comment','write_content','assign','schedule','publish',
      'approve_creative','approve_process','approve_budget','manage_assets',
      'enter_metrics','review_performance','manage_settings','manage_roles',
      'view_content_body','view_activity','compare_versions']),
  ('mos_ceo', ARRAY[
      'read','comment','approve_budget','review_performance']),
  ('mos_ops_supervisor', ARRAY[
      'read','comment','assign','schedule','publish','approve_process',
      'manage_assets','enter_metrics','review_performance',
      'view_content_body','view_activity','compare_versions']),
  ('mos_writer', ARRAY[
      'read','comment','write_content','schedule','publish',
      'view_content_body','view_activity','compare_versions']),
  ('mos_montage', ARRAY[
      'read','comment','write_content','manage_assets',
      'view_content_body','view_activity','compare_versions'])
) AS seed(role_key, caps)
JOIN public.roles r ON r.key = seed.role_key
CROSS JOIN LATERAL unnest(seed.caps) AS cap
ON CONFLICT (role_id, capability) DO NOTHING;

-- 4. Parity self-check — the seed MUST reproduce the old CASE --------------
-- Independently re-encodes the old CASE and asserts the seeded table matches
-- it for every (grantable role × base capability). A seed typo aborts the
-- migration. The three new view_* caps are excluded (they have no CASE twin).
DO $parity$
DECLARE
  v_caps  text[] := ARRAY['read','comment','write_content','assign','schedule',
    'publish','approve_creative','approve_process','approve_budget',
    'manage_assets','enter_metrics','review_performance','manage_settings',
    'manage_roles'];
  v_roles text[] := ARRAY['marketing_manager','ceo','ops_supervisor','writer','montage'];
  rk text; cap text; expected boolean; actual boolean;
BEGIN
  FOREACH rk IN ARRAY v_roles LOOP
    FOREACH cap IN ARRAY v_caps LOOP
      expected := CASE rk
        WHEN 'marketing_manager' THEN true
        WHEN 'ceo' THEN cap = ANY(ARRAY['read','comment','approve_budget','review_performance'])
        WHEN 'ops_supervisor' THEN cap = ANY(ARRAY['read','comment','assign','schedule',
          'publish','approve_process','manage_assets','enter_metrics','review_performance'])
        WHEN 'writer' THEN cap = ANY(ARRAY['read','comment','write_content','schedule','publish'])
        WHEN 'montage' THEN cap = ANY(ARRAY['read','comment','write_content','manage_assets'])
        ELSE false
      END;
      actual := EXISTS (
        SELECT 1 FROM public.role_capabilities rc
        JOIN public.roles r ON r.id = rc.role_id
        WHERE r.key = 'mos_' || rk AND rc.capability = cap
      );
      IF expected <> actual THEN
        RAISE EXCEPTION 'role_capabilities parity mismatch: role=% cap=% expected=% actual=%',
          rk, cap, expected, actual;
      END IF;
    END LOOP;
  END LOOP;
END
$parity$;

COMMIT;
