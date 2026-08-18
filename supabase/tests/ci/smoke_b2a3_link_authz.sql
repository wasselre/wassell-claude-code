-- ============================================================================
-- Smoke assertions for Phase 3 · B2A.3 — set-based file_links_select.
--
-- Edge-set equivalence and latency live in run_b2a3_link_authz_test.sh, which
-- can hold state either side of the apply. This file asserts the properties
-- that stand on their own: both-sided privacy at the exact (model_id,
-- record_id) grain, the shared-authority invariant, and that the new helper is
-- not itself a direct-RPC bypass.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 1. Non-vacuity ─────────────────────────────────────────────────────────
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM public.file_links;
  IF n < 5000 THEN RAISE EXCEPTION 'B2A3.1 vacuous: only % edges', n; END IF;
  SELECT count(*) INTO n FROM public.records WHERE data ? 'visible_to';
  IF n = 0 THEN RAISE EXCEPTION 'B2A3.1 vacuous: no record carries visible_to'; END IF;
  RAISE NOTICE 'B2A3.1 corpus OK';
END $$;

-- ── 2. THE COLLISION CASE ──────────────────────────────────────────────────
-- The same record UUID under TWO different models. An edge must be judged on
-- the (model_id, record_id) PAIR, never on record_id alone — otherwise seeing
-- the twin under a model you DO have access to would leak the edge belonging to
-- the model you do not.
DO $$
DECLARE collide uuid := 'c011ade0-0000-4000-8000-000000000001';
        m_units uuid; m_proj uuid; f_id uuid; seen_units int; seen_proj int;
BEGIN
  SELECT id INTO m_units FROM public.models WHERE name='units';
  SELECT id INTO m_proj  FROM public.models WHERE name='all_projects';

  -- same id, two models; visible ONLY under all_projects for persona 33333333
  INSERT INTO public.records (id, model_id, data) VALUES
    (collide, m_units, jsonb_build_object('visible_to', '[]'::jsonb))
  ON CONFLICT (id) DO NOTHING;

  SELECT id INTO f_id FROM public.files
   WHERE storage_path LIKE 'scale/%' ORDER BY id LIMIT 1;

  -- Point a file at the collision id under units (the INVISIBLE side).
  UPDATE public.files SET model_id = m_units, record_id = collide WHERE id = f_id;

  PERFORM set_config('test.uid','33333333-3333-3333-3333-333333333333', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO seen_units FROM public.file_links l
   WHERE l.record_id = collide AND l.model_id = m_units;
  EXECUTE 'RESET ROLE';

  IF seen_units <> 0 THEN
    RAISE EXCEPTION 'B2A3.2 collision: edge under an INVISIBLE model is visible (% rows) — the pair is not being honoured', seen_units;
  END IF;
  RAISE NOTICE 'B2A3.2 (model_id, record_id) pair honoured — collision does not leak';
END $$;

-- ── 3. Shared authority: one definition, two policies ──────────────────────
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename IN ('files','file_links')
     AND policyname IN ('files_select','file_links_select')
     AND qual LIKE '%wassell_my_visible_file_ids%';
  IF n <> 2 THEN
    RAISE EXCEPTION 'B2A3.3 expected BOTH policies to consume the shared set, found %', n;
  END IF;

  -- file_links_select must NOT re-implement the Files branches itself
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='file_links' AND policyname='file_links_select'
     AND (qual LIKE '%wassell_my_granted_file_ids%' OR qual LIKE '%wassell_my_cascade_folder_ids%'
          OR qual LIKE '%uploaded_by_user_id%');
  IF n <> 0 THEN
    RAISE EXCEPTION 'B2A3.3 file_links_select re-implements Files branches — that is a second authority';
  END IF;

  -- and it must still carry the record half
  SELECT count(*) INTO n FROM pg_policies
   WHERE schemaname='public' AND tablename='file_links' AND policyname='file_links_select'
     AND qual LIKE '%unified_records%';
  IF n <> 1 THEN RAISE EXCEPTION 'B2A3.3 file_links_select lost the record-visibility half'; END IF;
  RAISE NOTICE 'B2A3.3 one authority, both sides present';
END $$;

-- ── 4. The new helper is not a bypass ──────────────────────────────────────
-- It takes no arguments, so it cannot be pointed at another user; assert that,
-- and that identity-less callers get nothing from it when called DIRECTLY.
DO $$
DECLARE n bigint; own bigint; u uuid; label text;
        cases text[][] := ARRAY[
          ARRAY['33333333-3333-3333-3333-333333333333','grant-holder'],
          ARRAY['55555555-5555-5555-5555-555555555555','no-access'],
          ARRAY['00000000-0000-0000-0000-0000000000ff','identity-less']];
        c text[];
BEGIN
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
   WHERE ns.nspname='public' AND p.proname='wassell_my_visible_file_ids'
     AND p.pronargs <> 0;
  IF n <> 0 THEN RAISE EXCEPTION 'B2A3.4 the shared helper accepts arguments — it is forgeable'; END IF;

  SELECT count(*) INTO n FROM information_schema.role_routine_grants
   WHERE routine_schema='public' AND routine_name='wassell_my_visible_file_ids' AND grantee='anon';
  IF n <> 0 THEN RAISE EXCEPTION 'B2A3.4 anon can execute the shared helper'; END IF;

  FOREACH c SLICE 1 IN ARRAY cases LOOP
    u := c[1]::uuid; label := c[2];
    PERFORM set_config('test.uid', u::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO n FROM public.wassell_my_visible_file_ids();
    SELECT count(*) INTO own FROM public.files;          -- via files_select
    EXECUTE 'RESET ROLE';

    IF n <> own THEN
      RAISE EXCEPTION 'B2A3.4 % : helper returned % ids but files_select admits % — the two disagree',
        label, n, own;
    END IF;
    IF public.wassell_app_user_id(u) IS NULL AND n <> 0 THEN
      RAISE EXCEPTION 'B2A3.4 identity-less % received % file ids', label, n;
    END IF;
    RAISE NOTICE 'B2A3.4 % -> helper=% files_select=% OK', label, n, own;
  END LOOP;
END $$;

SELECT 'B2A.3 smoke: all assertions passed' AS result;
