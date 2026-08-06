-- Access re-architecture · Phase 1 — wassell_mos_can reads DATA, not a CASE
--
-- The function SIGNATURE is unchanged, so every mos_* RLS policy that calls
-- wassell_mos_can('...') keeps working with zero policy edits. Only the BODY
-- changes: the hardcoded per-role CASE becomes a lookup against the
-- role_capabilities table seeded in Phase 0 (which a parity self-check already
-- proved reproduces the CASE exactly).
--
-- Two paths stay hardcoded ON PURPOSE — they are not customizable marketing
-- roles:
--   • app admins (wassell_is_admin) remain marketing superusers.
--   • the 'viewer' floor — a person with no marketing role can still 'read'.
--
-- OLD BODY (kept here for rollback):
--   SELECT COALESCE(bool_or(CASE role_name
--     WHEN 'administrator'     THEN true
--     WHEN 'marketing_manager' THEN true
--     WHEN 'ceo' THEN p_capability IN ('read','comment','approve_budget','review_performance')
--     WHEN 'ops_supervisor' THEN p_capability IN ('read','comment','assign','schedule','publish',
--         'approve_process','manage_assets','enter_metrics','review_performance')
--     WHEN 'writer' THEN p_capability IN ('read','comment','write_content','schedule','publish')
--     WHEN 'montage' THEN p_capability IN ('read','comment','write_content','manage_assets')
--     WHEN 'viewer' THEN p_capability IN ('read')
--     ELSE false END), false)
--   FROM unnest(public.wassell_mos_roles(p_auth_uid)) AS role_name;

BEGIN;

CREATE OR REPLACE FUNCTION public.wassell_mos_can(
  p_capability text,
  p_auth_uid uuid DEFAULT auth.uid()
)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    -- App admins are marketing superusers (unchanged bypass).
    public.wassell_is_admin(p_auth_uid)
    -- Data-driven: any held marketing role granted this capability.
    OR EXISTS (
      SELECT 1
      FROM unnest(public.wassell_mos_roles(p_auth_uid)) AS h(role_key)
      JOIN public.roles r ON r.key = 'mos_' || h.role_key
      JOIN public.role_capabilities rc
        ON rc.role_id = r.id AND rc.capability = p_capability
    )
    -- Viewer floor: no marketing role at all still means read-only.
    OR (p_capability = 'read'
        AND 'viewer' = ANY (public.wassell_mos_roles(p_auth_uid)));
$function$;

-- Functional parity — run the NEW function end-to-end for a real single-role
-- holder of each grantable role and assert it equals the old CASE. Roles with
-- no single-role holder are covered by the Phase-0 table parity check; here we
-- exercise the full auth_uid → wassell_mos_roles → role_capabilities path.
DO $parity$
DECLARE
  v_caps  text[] := ARRAY['read','comment','write_content','assign','schedule',
    'publish','approve_creative','approve_process','approve_budget',
    'manage_assets','enter_metrics','review_performance','manage_settings',
    'manage_roles'];
  v_roles text[] := ARRAY['marketing_manager','ceo','ops_supervisor','writer','montage'];
  rk text; cap text; v_uid uuid; expected boolean; actual boolean;
BEGIN
  FOREACH rk IN ARRAY v_roles LOOP
    SELECT u.auth_uid INTO v_uid
      FROM public.users u
     WHERE u.is_active AND u.auth_uid IS NOT NULL
       AND public.wassell_mos_roles(u.auth_uid) = ARRAY[rk]
     LIMIT 1;
    CONTINUE WHEN v_uid IS NULL;  -- no clean single-role holder → table parity covers it
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
      actual := public.wassell_mos_can(cap, v_uid);
      IF expected <> actual THEN
        RAISE EXCEPTION 'wassell_mos_can functional parity mismatch: role=% cap=% expected=% actual=%',
          rk, cap, expected, actual;
      END IF;
    END LOOP;
  END LOOP;
END
$parity$;

COMMIT;
