-- ============================================================================
-- mos_role_grant — grant/revoke ONE marketing role for ONE user, server-side.
--
-- Runs AFTER 2026-08-01_01_workflow_engine_role_paths.sql (canonical roles
-- with key 'mos_*', users.role_assignments as the grant store).
--
-- WHY AN RPC: grants fold into users.role_assignments (a jsonb array), and a
-- read-modify-write of that array from the browser is a lost-update race the
-- moment two admins edit roles at once. One SECURITY DEFINER call makes the
-- check + mutate atomic and puts authorization in the same transaction.
-- Multi-role is the point: this appends/removes ONE element, never replaces
-- the array.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION public.mos_role_grant(
  p_user_id  uuid,
  p_role_key text,
  p_grant    boolean
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_full_key text;
  v_role_id  uuid;
  v_current  jsonb;
BEGIN
  -- Definer rights bypass RLS, so the authorization lives here. manage_roles
  -- is held by app admins and the Marketing Manager (see wassell_mos_can).
  IF NOT public.wassell_mos_can('manage_roles') THEN
    RAISE EXCEPTION 'MOS:NOT_ALLOWED' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Accept the key with or without the mos_ prefix; validate against the five.
  v_full_key := CASE
    WHEN p_role_key LIKE 'mos\_%' THEN p_role_key
    ELSE 'mos_' || p_role_key
  END;
  IF v_full_key NOT IN (
    'mos_ceo', 'mos_marketing_manager', 'mos_ops_supervisor',
    'mos_writer', 'mos_montage'
  ) THEN
    RAISE EXCEPTION 'MOS:UNKNOWN_ROLE %', p_role_key;
  END IF;

  SELECT id INTO v_role_id FROM public.roles WHERE key = v_full_key;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'MOS:UNKNOWN_ROLE %', p_role_key;
  END IF;

  SELECT COALESCE(u.role_assignments, '[]'::jsonb)
    INTO v_current
    FROM public.users u
   WHERE u.id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MOS:UNKNOWN_USER';
  END IF;

  -- Strip any existing assignment of this role (idempotent re-grant, and the
  -- revoke path), then append on grant. Array order is otherwise preserved.
  v_current := COALESCE(
    (SELECT jsonb_agg(elem)
       FROM jsonb_array_elements(v_current) elem
      WHERE elem->>'role_id' <> v_role_id::text),
    '[]'::jsonb
  );

  IF p_grant THEN
    v_current := v_current
      || jsonb_build_object('role_id', v_role_id::text, 'field_values', '{}'::jsonb);
  END IF;

  UPDATE public.users
     SET role_assignments = v_current
   WHERE id = p_user_id;
END $function$;

COMMENT ON FUNCTION public.mos_role_grant(uuid, text, boolean) IS
  'Grant or revoke ONE mos_* role for ONE user inside users.role_assignments. '
  'Atomic (row-locked read-modify-write) and self-authorizing via '
  'wassell_mos_can(''manage_roles'').';

GRANT EXECUTE ON FUNCTION public.mos_role_grant(uuid, text, boolean) TO authenticated;

COMMIT;
