-- bind_my_auth_uid — close the chicken-and-egg in the user-binding flow.
--
-- The problem this fixes (introduced 2026-05-06 in commit 4515af3,
-- "Phase 1 — RLS real enforcement at the DB layer"):
--
-- Every newly-invited user has public.users.auth_uid = NULL until first
-- sign-in. The client-side bindAuthUidToUser in appStore.ts tries to
-- UPDATE public.users SET auth_uid = <their auth.uid()> via supabaseUpsert,
-- but the users_write RLS policy (USING wassell_is_admin(auth.uid()) OR
-- users.auth_uid = auth.uid()) evaluates the OLD row's auth_uid (which is
-- NULL) and the user isn't admin yet — both legs fail, PostgREST silently
-- returns 0 rows updated, and the binding never lands. From RLS's
-- perspective the user then doesn't exist: every records-RLS check joins
-- users.auth_uid = auth.uid(), so the records list comes back empty.
--
-- The fix: a SECURITY DEFINER function runs as the function owner
-- (postgres), bypassing RLS, and atomically binds the caller's
-- auth.uid() to the matching public.users row. Guards prevent abuse:
--   1. auth.uid() must be present (no anon).
--   2. The JWT must carry an email claim.
--   3. We only ever populate a NULL auth_uid — never overwrite an
--      existing binding (otherwise a hijacked email at the auth layer
--      could rebind a colleague's app account).
--   4. The matching row must be is_active = true (deactivated users
--      can't bind themselves back in).
--
-- Idempotent: if the caller is already bound, returns the existing id
-- without writing. Re-running is a no-op once bound.
--
-- Returns NULL when no app user row matches the JWT's email — the
-- caller treats this as "access denied, ask an admin to provision you."

CREATE OR REPLACE FUNCTION public.bind_my_auth_uid()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller_uid uuid := auth.uid();
  caller_email text := lower(coalesce((auth.jwt() ->> 'email'), ''));
  bound_user_id uuid;
BEGIN
  IF caller_uid IS NULL THEN
    -- No session at all — fail loud rather than silently returning NULL,
    -- so the client surfaces a real auth error.
    RAISE EXCEPTION 'no_session' USING ERRCODE = '28000';
  END IF;

  IF caller_email = '' THEN
    -- The JWT is signed but missing an email claim. This shouldn't
    -- happen for Supabase Auth's standard providers, but if it does we
    -- can't bind because the lookup is keyed on email.
    RAISE EXCEPTION 'no_email_claim' USING ERRCODE = '28000';
  END IF;

  -- Already bound to this caller → no-op, return existing id.
  SELECT id INTO bound_user_id
    FROM public.users
   WHERE auth_uid = caller_uid AND is_active = true
   LIMIT 1;
  IF bound_user_id IS NOT NULL THEN
    RETURN bound_user_id;
  END IF;

  -- First-time bind: only fill when the slot is currently NULL.
  -- The lower(email) match is case-insensitive to mirror the JS lookup
  -- in initialize(). is_active = true defense-in-depth: a deactivated
  -- account shouldn't be able to bind itself back into RLS.
  UPDATE public.users
     SET auth_uid    = caller_uid,
         updated_at  = now()
   WHERE auth_uid IS NULL
     AND lower(email) = caller_email
     AND is_active = true
   RETURNING id INTO bound_user_id;

  RETURN bound_user_id;  -- NULL means "no app user with this email" — caller decides.
END
$$;

-- Lock down execution: only signed-in users can call this. Anon must
-- not be able to touch the users table even indirectly.
--
-- We REVOKE from BOTH PUBLIC and anon explicitly. Supabase's project
-- defaults include `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT
-- EXECUTE ON FUNCTIONS TO anon`, so newly-created functions auto-grant
-- to anon even after a PUBLIC revoke — the explicit anon revoke is the
-- only way to actually lock the function down. Other public-schema
-- functions follow the same posture per the 2026-05-07 B.1/B.2
-- hardening (only `get_public_dashboard` should remain reachable by
-- anon).
REVOKE ALL ON FUNCTION public.bind_my_auth_uid() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_my_auth_uid() FROM anon;
GRANT  EXECUTE ON FUNCTION public.bind_my_auth_uid() TO authenticated;
