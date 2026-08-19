-- ============================================================================
-- B4 — record-derived view access. Assertions.
--
-- This batch GRANTS ACCESS, which makes it the opposite of every Files batch so
-- far: B2A/B2A.2/B2A.4 all had to prove reach did not move, and here reach is
-- supposed to move. So "it changed" proves nothing — the tests must pin down
-- EXACTLY who gains what, and prove the two boundaries that must not move:
-- restricted files, and edit/delete/share.
--
-- Production cannot exercise the restricted boundary at all: all 7,548 files
-- are `internal` and the two restricted-by-default types have zero rows. So
-- §3 MANUFACTURES a restricted file rather than reporting a vacuous pass.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 1. Ships dark ───────────────────────────────────────────────────────────
DO $$
DECLARE n bigint;
BEGIN
  IF public.wassell_file_derived_access_enabled() THEN
    RAISE EXCEPTION 'B4.1 toggle is ON at install time — B4 must ship dark';
  END IF;

  -- and the helper must return nothing while it is off, for anyone
  PERFORM set_config('test.uid','33333333-3333-3333-3333-333333333333', true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.wassell_my_record_derived_file_ids();
  EXECUTE 'RESET ROLE';
  IF n <> 0 THEN
    RAISE EXCEPTION 'B4.1 derived helper returned % ids with the toggle OFF', n;
  END IF;
  RAISE NOTICE 'B4.1 installed dark: toggle off, helper yields nothing';
END $$;

-- ── 2. Turn it on; every gain must be explainable ───────────────────────────
-- The prediction is computed HERE, independently of the policy, from the same
-- definition in English: a file becomes visible iff it is linked to a record
-- the caller can view and it is not restricted. If the policy and this
-- independent count disagree, one of them is wrong and the run fails.
UPDATE public.file_access_settings SET derived_view_enabled = true;

DO $$
DECLARE
  r record; v_pol bigint; v_pred bigint; v_base bigint; n_checked int := 0; n_gained int := 0;
  v_nvr bigint; v_nvf bigint; v_linked bigint;
BEGIN
  FOR r IN SELECT u.auth_uid AS uid, u.id AS app FROM public.users u ORDER BY u.id LOOP
    -- what the policy now grants
    PERFORM set_config('test.uid', r.uid::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_pol FROM public.files;
    EXECUTE 'RESET ROLE';

    -- Baseline AND the "already visible" snapshot must both be taken with the
    -- toggle OFF, in the same window.
    --
    -- They were not, and it produced a gain of exactly zero: _vf was captured
    -- after the toggle went back ON, so it already contained every file the
    -- derived branch adds, and NOT EXISTS(_vf) then excluded all of them. The
    -- instrumentation named it immediately -- "visible files=7263" was the
    -- POLICY count, not the 4651 baseline.
    UPDATE public.file_access_settings SET derived_view_enabled = false;
    PERFORM set_config('test.uid', r.uid::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO v_base FROM public.files;
    CREATE TEMP TABLE _vf ON COMMIT DROP AS SELECT id FROM public.files;
    CREATE TEMP TABLE _vr ON COMMIT DROP AS
      SELECT ur.id, ur.model_id FROM public.unified_records ur;
    EXECUTE 'RESET ROLE';
    UPDATE public.file_access_settings SET derived_view_enabled = true;

    -- Guard the window itself: if the snapshot ever again matches the
    -- post-toggle count instead of the baseline, fail here rather than
    -- silently predicting zero.
    IF (SELECT count(*) FROM _vf) <> v_base THEN
      RAISE EXCEPTION 'B4.2 % : the already-visible snapshot (%) was not taken with the toggle OFF (baseline %)',
        left(r.uid::text,8), (SELECT count(*) FROM _vf), v_base;
    END IF;

    SELECT count(*) INTO v_pred
      FROM public.files f
     WHERE f.confidentiality IS DISTINCT FROM 'restricted'
       AND EXISTS (SELECT 1 FROM public.file_links l
                     JOIN public.records rr ON rr.id = l.record_id AND rr.model_id = l.model_id
                     JOIN _vr v ON v.id = l.record_id AND v.model_id = l.model_id
                    WHERE l.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM _vf b WHERE b.id = f.id);

    -- Instrumented: when this assertion fires, the intermediate counts decide
    -- whether the POLICY over-granted or the PREDICTION under-counted. Without
    -- them the failure message is a mismatch with no way to attribute it, which
    -- is how a debugging session turns into a guessing session.
    SELECT count(*) INTO v_nvr FROM _vr;
    SELECT count(*) INTO v_nvf FROM _vf;
    SELECT count(DISTINCT l.file_id) INTO v_linked
      FROM public.file_links l
      JOIN _vr v ON v.id = l.record_id AND v.model_id = l.model_id;

    DROP TABLE _vf; DROP TABLE _vr;

    IF v_pol <> v_base + v_pred THEN
      RAISE EXCEPTION E'B4.2 % : policy=% baseline=% predicted_gain=% (expected %)
'
        '   visible records=%  visible files=%  files linked to visible records=%
'
        '   -> if visible records is 0 the PREDICTION is broken; if it is large and
'
        '      linked-files is small, the POLICY is over-granting.',
        left(r.uid::text,8), v_pol, v_base, v_pred, v_base + v_pred,
        v_nvr, v_nvf, v_linked;
    END IF;
    n_checked := n_checked + 1;
    IF v_pred > 0 THEN n_gained := n_gained + 1; END IF;
    RAISE NOTICE 'B4.2 % base=% gain=% total=%', left(r.uid::text,8), v_base, v_pred, v_pol;
  END LOOP;

  IF n_checked = 0 THEN
    RAISE EXCEPTION 'B4.2 vacuous: no users to check';
  END IF;
  IF n_gained = 0 THEN
    RAISE EXCEPTION 'B4.2 vacuous: NOBODY gained a file, so the derived branch is never exercised';
  END IF;
  RAISE NOTICE 'B4.2 % users checked, % actually gained — branch is live and exact', n_checked, n_gained;
END $$;

-- ── 3. THE BOUNDARY: restricted files must NOT come through ─────────────────
-- Manufactured on purpose. A corpus with no restricted files cannot fail this
-- test, and a test that cannot fail is not evidence.
DO $$
DECLARE
  v_uid uuid; v_file uuid; v_model uuid; v_rec uuid; v_seen bigint; v_seen_after bigint;
BEGIN
  -- a caller who gains something from the derived branch (so the branch is the
  -- only way they could reach the file we are about to build)
  SELECT u.auth_uid INTO v_uid
    FROM public.users u
   WHERE NOT public.wassell_is_admin(u.auth_uid)
   ORDER BY u.id LIMIT 1;

  -- a record this caller CAN see, that already carries links
  PERFORM set_config('test.uid', v_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT ur.id, ur.model_id INTO v_rec, v_model
    FROM public.unified_records ur
   WHERE EXISTS (SELECT 1 FROM public.file_links l
                  WHERE l.record_id = ur.id AND l.model_id = ur.model_id)
   LIMIT 1;
  EXECUTE 'RESET ROLE';

  IF v_rec IS NULL THEN
    RAISE EXCEPTION 'B4.3 vacuous: the chosen caller can see no linked record, so the derived branch is untestable for them';
  END IF;

  -- a RESTRICTED file, owned by nobody they are, in no folder they hold,
  -- reachable ONLY through the derived branch
  INSERT INTO public.files (id, original_name, storage_bucket, storage_path,
                            kind, mime_type, size_bytes, file_class,
                            confidentiality, status, document_type, title)
  VALUES (gen_random_uuid(), 'b4-restricted-probe.pdf', 'wassel-files',
          'b4/probe.pdf', 'pdf', 'application/pdf', 1, 'business',
          'restricted', 'active', 'contract', 'B4 restricted probe')
  RETURNING id INTO v_file;

  INSERT INTO public.file_links (file_id, model_id, record_id, role)
  VALUES (v_file, v_model, v_rec, 'b4_probe')
  ON CONFLICT ON CONSTRAINT file_links_identity DO NOTHING;

  PERFORM set_config('test.uid', v_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_seen FROM public.files WHERE id = v_file;
  EXECUTE 'RESET ROLE';

  IF v_seen <> 0 THEN
    RAISE EXCEPTION 'B4.3 RESTRICTED FILE LEAKED through the derived branch';
  END IF;

  -- NEGATIVE CONTROL: the same file, unrestricted, MUST come through. Without
  -- this, §3 would also "pass" if the derived branch were broken entirely.
  UPDATE public.files SET confidentiality = 'internal' WHERE id = v_file;
  PERFORM set_config('test.uid', v_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_seen_after FROM public.files WHERE id = v_file;
  EXECUTE 'RESET ROLE';

  IF v_seen_after <> 1 THEN
    RAISE EXCEPTION 'B4.3 control failed: the same file is invisible even when NOT restricted (%), so §3 proved nothing about suppression', v_seen_after;
  END IF;

  DELETE FROM public.file_links WHERE file_id = v_file;
  DELETE FROM public.files WHERE id = v_file;
  RAISE NOTICE 'B4.3 restricted suppressed, identical file visible when internal — suppression is real';
END $$;

-- ── 4. Identity-less and deactivated callers gain NOTHING ───────────────────
DO $$
DECLARE u text; n bigint;
  uids text[] := ARRAY['00000000-0000-0000-0000-0000000000ff',
                       '00000000-0000-0000-0000-0000000000fe'];
BEGIN
  FOREACH u IN ARRAY uids LOOP
    PERFORM set_config('test.uid', u, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO n FROM public.files;
    EXECUTE 'RESET ROLE';
    IF n <> 0 THEN
      RAISE EXCEPTION 'B4.4 identity-less caller % sees % files with the derived branch ON', left(u,8), n;
    END IF;

    PERFORM set_config('test.uid', u, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) INTO n FROM public.wassell_my_record_derived_file_ids();
    EXECUTE 'RESET ROLE';
    IF n <> 0 THEN
      RAISE EXCEPTION 'B4.4 identity-less caller % got % ids from the derived helper', left(u,8), n;
    END IF;
  END LOOP;
  RAISE NOTICE 'B4.4 identity-less callers gain nothing through policy or helper';
END $$;

-- ── 5. VIEW ONLY: edit, delete and share must be untouched ──────────────────
-- D1 is a view grant. If B4 moved any write boundary it is a different feature
-- than the one that was approved.
DO $$
DECLARE q text; n bigint;
BEGIN
  FOR q IN
    SELECT pg_get_expr(p.polqual, p.polrelid)
      FROM pg_policy p
     WHERE p.polrelid IN ('public.files'::regclass, 'public.file_links'::regclass)
       AND p.polcmd <> 'r'
  LOOP
    IF position('derived' IN q) <> 0 OR position('wassell_file_derived_access_enabled' IN q) <> 0 THEN
      RAISE EXCEPTION 'B4.5 a NON-SELECT policy references the derived branch — B4 is view-only';
    END IF;
  END LOOP;

  SELECT count(*) INTO n
    FROM pg_policy p
   WHERE p.polrelid IN ('public.files'::regclass, 'public.file_links'::regclass)
     AND p.polcmd = 'r'
     AND position('wassell_file_derived_access_enabled' IN pg_get_expr(p.polqual, p.polrelid)) <> 0;
  IF n <> 2 THEN
    RAISE EXCEPTION 'B4.5 expected both SELECT policies to carry the derived branch, found %', n;
  END IF;
  RAISE NOTICE 'B4.5 derived branch present on both SELECT policies, absent from every write policy';
END $$;

-- ── 6. The denormalized confidentiality must not go stale ───────────────────
DO $$
DECLARE v_file uuid; v_old text; n_bad bigint;
BEGIN
  SELECT count(*) INTO n_bad
    FROM public.file_links l JOIN public.files f ON f.id = l.file_id
   WHERE l.confidentiality IS DISTINCT FROM f.confidentiality;
  IF n_bad <> 0 THEN
    RAISE EXCEPTION 'B4.6 % edge(s) disagree with their file on confidentiality', n_bad;
  END IF;

  SELECT l.file_id INTO v_file FROM public.file_links l LIMIT 1;
  SELECT confidentiality INTO v_old FROM public.files WHERE id = v_file;
  UPDATE public.files SET confidentiality = 'restricted' WHERE id = v_file;
  SELECT count(*) INTO n_bad FROM public.file_links
   WHERE file_id = v_file AND confidentiality IS DISTINCT FROM 'restricted';
  IF n_bad <> 0 THEN
    RAISE EXCEPTION 'B4.6 marking a file restricted left % edge(s) stale — a restricted file would stay reachable', n_bad;
  END IF;
  UPDATE public.files SET confidentiality = v_old WHERE id = v_file;
  RAISE NOTICE 'B4.6 confidentiality propagates to edges on change';
END $$;

-- ── 7. Leave it as it shipped ───────────────────────────────────────────────
UPDATE public.file_access_settings SET derived_view_enabled = false;
DO $$
BEGIN
  IF public.wassell_file_derived_access_enabled() THEN
    RAISE EXCEPTION 'B4.7 failed to restore the dark state';
  END IF;
  RAISE NOTICE 'B4.7 toggle restored to OFF';
END $$;

SELECT 'B4 derived access smoke: all assertions passed' AS result;
