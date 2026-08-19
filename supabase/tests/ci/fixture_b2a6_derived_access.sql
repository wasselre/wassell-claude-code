-- ============================================================================
-- B4's record-derived access objects, layered on fixture_b2a5_record_scope.sql.
--
-- Without these the b2a5 suite cannot exercise `wassell_my_record_derived_file_ids`
-- at all, and B2A.6 would ship with its only evidence coming from production
-- measurement — the fixture-gentler-than-production trap, one level up.
--
-- Only what the CALL SITE needs is modelled: the settings row + kill switch, the
-- identity helper, and the baseline (pre-B2A.6) helper itself. B4's policy-side
-- pieces — `files`, the denormalized `confidentiality` column on `file_links`,
-- the folder/grant branches of `files_select` — are deliberately NOT reproduced.
-- They gate which file ids the POLICY accepts; they do not change which ids this
-- FUNCTION computes, which is what B2A.6 rewrites. Adding them would make the
-- suite look more thorough while testing the same thing.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.file_access_settings (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  derived_view_enabled boolean NOT NULL DEFAULT false,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- ON, as production has been since 2026-08-19 11:09 UTC. The OFF case is
-- asserted separately by the runner, because a kill switch that is never
-- exercised is not a kill switch.
INSERT INTO public.file_access_settings (id, derived_view_enabled)
VALUES (true, true)
ON CONFLICT (id) DO UPDATE SET derived_view_enabled = EXCLUDED.derived_view_enabled;

CREATE OR REPLACE FUNCTION public.wassell_file_derived_access_enabled()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT coalesce((SELECT s.derived_view_enabled
                     FROM public.file_access_settings s WHERE s.id), false)
$$;

CREATE OR REPLACE FUNCTION public.wassell_app_user_id(auth_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT id FROM public.users WHERE auth_uid = auth_user_id AND is_active = true LIMIT 1;
$$;

-- The PRE-B2A.6 helper, verbatim from production (2026-08-19). This is the
-- baseline every derived-set fingerprint is taken against.
CREATE OR REPLACE FUNCTION public.wassell_my_record_derived_file_ids()
RETURNS TABLE (file_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp' AS $$
  SELECT DISTINCT l.file_id
    FROM public.file_links l
    JOIN public.records r
      ON r.id = l.record_id AND r.model_id = l.model_id
   WHERE public.wassell_file_derived_access_enabled()
     AND public.wassell_app_user_id((SELECT auth.uid())) IS NOT NULL
     AND public.wassell_can_view_record((SELECT auth.uid()), r.*)
$$;

GRANT EXECUTE ON FUNCTION public.wassell_file_derived_access_enabled() TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_app_user_id(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.wassell_my_record_derived_file_ids() TO authenticated;

-- ── NON-VACUITY for the derived call site ──────────────────────────────────
-- B2A.6's whole value depends on the personas differing HERE, not just on the
-- records policy. Assert that before anything is measured.
DO $$
DECLARE n_admin int; n_all int; n_partial int; n_noview int; n_inactive int; n_orphan int;
BEGIN
  PERFORM set_config('test.uid','99999999-9999-9999-9999-999999999999', true);
  SELECT count(*) INTO n_admin    FROM public.wassell_my_record_derived_file_ids();
  PERFORM set_config('test.uid','11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO n_all      FROM public.wassell_my_record_derived_file_ids();
  PERFORM set_config('test.uid','22222222-2222-2222-2222-222222222222', true);
  SELECT count(*) INTO n_partial  FROM public.wassell_my_record_derived_file_ids();
  PERFORM set_config('test.uid','44444444-4444-4444-4444-444444444444', true);
  SELECT count(*) INTO n_noview   FROM public.wassell_my_record_derived_file_ids();
  PERFORM set_config('test.uid','55555555-5555-5555-5555-555555555555', true);
  SELECT count(*) INTO n_inactive FROM public.wassell_my_record_derived_file_ids();
  PERFORM set_config('test.uid','', true);

  SELECT count(*) INTO n_orphan FROM public.file_links l
   WHERE NOT EXISTS (SELECT 1 FROM public.records r
                      WHERE r.id = l.record_id AND r.model_id = l.model_id);

  RAISE NOTICE 'B2A.6 derived sets: admin=%  allscope=%  partial=%  noview=%  inactive=%  (orphan edges=%)',
    n_admin, n_all, n_partial, n_noview, n_inactive, n_orphan;

  IF n_admin = 0        THEN RAISE EXCEPTION 'admin derives no files — call site not exercised'; END IF;
  IF n_noview   <> 0    THEN RAISE EXCEPTION 'edit-without-view persona derives % files', n_noview; END IF;
  IF n_inactive <> 0    THEN RAISE EXCEPTION 'deactivated persona derives % files', n_inactive; END IF;
  IF n_partial = 0 OR n_partial >= n_admin THEN
    RAISE EXCEPTION 'filtered persona derives % of % — not a partial, the residue branch is vacuous',
      n_partial, n_admin;
  END IF;
  IF n_all = n_admin THEN
    RAISE EXCEPTION 'all-scope persona derives exactly what admin does — personas do not discriminate here';
  END IF;
  IF n_orphan = 0 THEN
    RAISE EXCEPTION 'no orphan edges — branch 1 existence check would be untested';
  END IF;
END $$;
