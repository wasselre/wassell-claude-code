-- ============================================================================
-- سارة is bound to the account she actually signs in with. 2026-09-20.
--
-- She held `mos_montage` in `users.role_assignments`, and at the database level
-- the role functions agreed — `wassell_mos_roles(her auth_uid)` returned
-- ['montage'] with seven capabilities. But the workspace told her:
--
--   «دورك الحالي «مطّلع» — يمكنك رؤية كل شيء دون تعديله»
--
-- and gave her no «مهامي» rail entry, so the only designer on the month could
-- not open, edit or deliver any of it.
--
-- The role functions default `p_auth_uid` to `auth.uid()`, and TWO auth
-- accounts exist for her:
--
--   sara.a@wassel.re   e47533c3-…  created 30 Aug, NEVER signed in   <- bound
--   sarah.a@wassel.re  7964a3b3-…  signs in daily, last 20 Sep 11:54 <- real
--
-- One letter. `users.auth_uid` pointed at the typo, so `auth.uid()` for her
-- real session matched no row: no roles, no capabilities, no surfaces, and the
-- workspace fell through to its viewer default. Every symptom, one cause.
--
-- Rebinding changes only the auth link. `users.id` is untouched, so her task
-- assignments, capacity row and authorship survive — they key off `users.id`,
-- never `auth_uid`.
--
-- The orphan `sara.a@wassel.re` auth account is left alone: it has never been
-- used, deleting an auth identity is not this migration's business, and it is
-- evidence of how this happened.
-- ============================================================================

BEGIN;

UPDATE public.users u
   SET auth_uid = a.id, updated_at = now()
  FROM auth.users a
 WHERE u.email = 'sarah.a@wassel.re'
   AND a.email = 'sarah.a@wassel.re'
   AND u.auth_uid IS DISTINCT FROM a.id;

DO $$
DECLARE v_roles text[]; v_caps text[]; v_bound boolean;
BEGIN
  SELECT (u.auth_uid = a.id) INTO v_bound
    FROM public.users u JOIN auth.users a ON a.email = u.email
   WHERE u.email = 'sarah.a@wassel.re';
  IF v_bound IS NOT TRUE THEN
    RAISE EXCEPTION 'MOS:SARAH_NOT_BOUND';
  END IF;

  -- And the role functions must now answer for the id she signs in with.
  SELECT public.wassell_mos_roles(u.auth_uid), public.wassell_mos_capabilities(u.auth_uid)
    INTO v_roles, v_caps
    FROM public.users u WHERE u.email = 'sarah.a@wassel.re';
  IF NOT ('montage' = ANY(v_roles)) THEN
    RAISE EXCEPTION 'MOS:SARAH_ROLES_STILL_EMPTY got %', v_roles;
  END IF;
  IF array_length(v_caps, 1) IS NULL OR array_length(v_caps, 1) < 1 THEN
    RAISE EXCEPTION 'MOS:SARAH_NO_CAPABILITIES';
  END IF;
  RAISE NOTICE 'سارة bound · roles=% · capabilities=%', v_roles, array_length(v_caps, 1);
END $$;

COMMIT;
