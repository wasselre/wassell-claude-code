-- ============================================================================
-- B2A.4 — denormalized link authorization.
--
-- Denormalization trades a join for a synchronisation obligation. Every
-- assertion here exists because breaking that obligation is the failure mode:
-- a stale uploaded_by_user_id or folder_id on file_links does not merely show
-- a wrong number, it GRANTS ACCESS THAT WAS REVOKED. So the invariant is
-- tested at rest AND under every mutation that can disturb it.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 1. Non-vacuity, then the invariant at rest ──────────────────────────────
DO $$
DECLARE n_edges bigint; n_bad bigint;
BEGIN
  SELECT count(*) INTO n_edges FROM public.file_links;
  IF n_edges < 100 THEN
    RAISE EXCEPTION 'B2A4.1 vacuous: only % edges — this suite proves nothing on an empty corpus', n_edges;
  END IF;

  SELECT count(*) INTO n_bad
    FROM public.file_links l JOIN public.files f ON f.id = l.file_id
   WHERE l.uploaded_by_user_id IS DISTINCT FROM f.uploaded_by_user_id
      OR l.folder_id           IS DISTINCT FROM f.folder_id;
  IF n_bad <> 0 THEN
    RAISE EXCEPTION 'B2A4.1 % edge(s) disagree with their file after backfill', n_bad;
  END IF;
  RAISE NOTICE 'B2A4.1 % edges, all agree with their file', n_edges;
END $$;

-- ── 2. The invariant must survive a FOLDER MOVE ─────────────────────────────
-- Phase 2's files_sync_file_links early-exits unless model_id/record_id change,
-- so a folder move reaches file_links only through the B2A.4 trigger. If that
-- trigger is ever dropped, this is the assertion that notices.
DO $$
DECLARE v_file uuid; v_old uuid; v_new uuid; n_bad bigint; n_edges bigint;
BEGIN
  SELECT l.file_id INTO v_file
    FROM public.file_links l JOIN public.files f ON f.id = l.file_id
   WHERE f.folder_id IS NOT NULL LIMIT 1;
  IF v_file IS NULL THEN
    RAISE EXCEPTION 'B2A4.2 vacuous: no linked file sits in a folder';
  END IF;

  SELECT folder_id INTO v_old FROM public.files WHERE id = v_file;
  SELECT id INTO v_new FROM public.folders WHERE id IS DISTINCT FROM v_old LIMIT 1;

  UPDATE public.files SET folder_id = v_new WHERE id = v_file;

  SELECT count(*) INTO n_edges FROM public.file_links WHERE file_id = v_file;
  SELECT count(*) INTO n_bad FROM public.file_links
   WHERE file_id = v_file AND folder_id IS DISTINCT FROM v_new;
  IF n_bad <> 0 THEN
    RAISE EXCEPTION 'B2A4.2 folder move left % of % edge(s) stale — denormalized authz is now WRONG', n_bad, n_edges;
  END IF;

  UPDATE public.files SET folder_id = v_old WHERE id = v_file;   -- restore
  SELECT count(*) INTO n_bad FROM public.file_links
   WHERE file_id = v_file AND folder_id IS DISTINCT FROM v_old;
  IF n_bad <> 0 THEN RAISE EXCEPTION 'B2A4.2 move-back left % edge(s) stale', n_bad; END IF;
  RAISE NOTICE 'B2A4.2 folder move propagates to all % edge(s), both directions', n_edges;
END $$;

-- ── 3. The invariant must survive an OWNER change ───────────────────────────
DO $$
DECLARE v_file uuid; v_old uuid; v_new uuid; n_bad bigint;
BEGIN
  SELECT l.file_id INTO v_file FROM public.file_links l LIMIT 1;
  SELECT uploaded_by_user_id INTO v_old FROM public.files WHERE id = v_file;
  SELECT id INTO v_new FROM public.users WHERE id IS DISTINCT FROM v_old LIMIT 1;
  IF v_new IS NULL THEN RAISE EXCEPTION 'B2A4.3 vacuous: fewer than two users'; END IF;

  UPDATE public.files SET uploaded_by_user_id = v_new WHERE id = v_file;
  SELECT count(*) INTO n_bad FROM public.file_links
   WHERE file_id = v_file AND uploaded_by_user_id IS DISTINCT FROM v_new;
  IF n_bad <> 0 THEN
    RAISE EXCEPTION 'B2A4.3 owner change left % edge(s) stale — the previous owner keeps access', n_bad;
  END IF;

  UPDATE public.files SET uploaded_by_user_id = v_old WHERE id = v_file;
  RAISE NOTICE 'B2A4.3 owner change propagates';
END $$;

-- ── 4. A NEW edge fills itself ──────────────────────────────────────────────
DO $$
DECLARE v_file uuid; v_model uuid; v_rec uuid; got_u uuid; got_f uuid; exp_u uuid; exp_f uuid;
BEGIN
  SELECT id, uploaded_by_user_id, folder_id INTO v_file, exp_u, exp_f
    FROM public.files WHERE folder_id IS NOT NULL LIMIT 1;
  SELECT model_id, record_id INTO v_model, v_rec FROM public.file_links LIMIT 1;

  INSERT INTO public.file_links (file_id, model_id, record_id, role)
  VALUES (v_file, v_model, v_rec, 'b2a4_probe')
  ON CONFLICT ON CONSTRAINT file_links_identity DO NOTHING;

  SELECT uploaded_by_user_id, folder_id INTO got_u, got_f
    FROM public.file_links
   WHERE file_id = v_file AND model_id = v_model AND record_id = v_rec AND role = 'b2a4_probe';

  IF got_u IS DISTINCT FROM exp_u OR got_f IS DISTINCT FROM exp_f THEN
    RAISE EXCEPTION 'B2A4.4 new edge not filled: got (%,%) expected (%,%)', got_u, got_f, exp_u, exp_f;
  END IF;

  DELETE FROM public.file_links
   WHERE file_id = v_file AND model_id = v_model AND record_id = v_rec AND role = 'b2a4_probe';
  RAISE NOTICE 'B2A4.4 new edge fills its authorization columns on insert';
END $$;

-- ── 5. THE ONE THAT MATTERS: revoking access must actually revoke it ────────
-- A folder-granted caller sees a file's edges. Move the file OUT of that
-- folder. If the denormalized column went stale the caller would keep seeing
-- edges for a file they can no longer reach — access surviving its own
-- revocation, which is the specific danger this design introduces.
DO $$
DECLARE
  v_uid uuid; v_folder uuid; v_file uuid; v_before bigint; v_after bigint; v_restored bigint;
BEGIN
  SELECT u.auth_uid, fp.folder_id INTO v_uid, v_folder
    FROM public.folder_permissions fp
    JOIN public.users u ON u.id = fp.user_id
   WHERE public.wassell_role_satisfies(fp.role, 'view')
     AND NOT public.wassell_is_admin(u.auth_uid)
   LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'B2A4.5 vacuous: no non-admin folder grant in the fixture';
  END IF;

  SELECT l.file_id INTO v_file
    FROM public.file_links l JOIN public.files f ON f.id = l.file_id
   WHERE f.folder_id = v_folder LIMIT 1;
  IF v_file IS NULL THEN
    RAISE EXCEPTION 'B2A4.5 vacuous: the granted folder holds no linked file';
  END IF;

  PERFORM set_config('test.uid', v_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_before FROM public.file_links WHERE file_id = v_file;
  EXECUTE 'RESET ROLE';

  IF v_before = 0 THEN
    RAISE EXCEPTION 'B2A4.5 vacuous: the folder-granted caller sees no edges to begin with';
  END IF;

  -- revoke by moving the file out of the granted folder
  UPDATE public.files SET folder_id = NULL WHERE id = v_file;

  PERFORM set_config('test.uid', v_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_after FROM public.file_links WHERE file_id = v_file;
  EXECUTE 'RESET ROLE';

  IF v_after <> 0 THEN
    RAISE EXCEPTION 'B2A4.5 ACCESS SURVIVED REVOCATION: caller still sees % edge(s) for a file removed from their granted folder', v_after;
  END IF;

  UPDATE public.files SET folder_id = v_folder WHERE id = v_file;

  PERFORM set_config('test.uid', v_uid::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_restored FROM public.file_links WHERE file_id = v_file;
  EXECUTE 'RESET ROLE';

  IF v_restored <> v_before THEN
    RAISE EXCEPTION 'B2A4.5 re-filing restored % edge(s), expected %', v_restored, v_before;
  END IF;
  RAISE NOTICE 'B2A4.5 revocation takes effect (% -> 0 -> %), and re-granting restores it', v_before, v_restored;
END $$;

-- ── 6. ONE AUTHORITY, structurally ──────────────────────────────────────────
-- Both policies are generated from a single predicate string differing only in
-- which column names the file. Normalise that away and the two must be equal.
DO $$
DECLARE q_files text; q_links text; n_files text; n_links text;
BEGIN
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO q_files
    FROM pg_policy pol WHERE pol.polname = 'files_select'
     AND pol.polrelid = 'public.files'::regclass;
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO q_links
    FROM pg_policy pol WHERE pol.polname = 'file_links_select'
     AND pol.polrelid = 'public.file_links'::regclass;

  IF q_files IS NULL OR q_links IS NULL THEN
    RAISE EXCEPTION 'B2A4.6 a policy is missing (files=%, links=%)',
      q_files IS NOT NULL, q_links IS NOT NULL;
  END IF;

  -- the link policy is the file policy AND the record half
  IF position('unified_records' IN q_links) = 0 THEN
    RAISE EXCEPTION 'B2A4.6 file_links_select lost the record-visibility half';
  END IF;
  IF position('unified_records' IN q_files) <> 0 THEN
    RAISE EXCEPTION 'B2A4.6 files_select acquired a record predicate it should not have';
  END IF;

  -- normalise the one intended difference, then require identity of the
  -- authorization half
  n_files := replace(q_files, '(id = ', '(FILE = ');
  n_files := replace(n_files, ' id IN ', ' FILE IN ');
  n_links := replace(q_links, '(file_id = ', '(FILE = ');
  n_links := replace(n_links, ' file_id IN ', ' FILE IN ');
  n_links := left(n_links, position(' AND (EXISTS' IN n_links) - 1);

  IF n_files IS DISTINCT FROM n_links THEN
    RAISE EXCEPTION E'B2A4.6 the two policies have DRIFTED apart.\nfiles: %\nlinks: %', n_files, n_links;
  END IF;

  -- and both must carry the identity invariant
  IF position('wassell_app_user_id' IN n_files) = 0 THEN
    RAISE EXCEPTION 'B2A4.6 the identity invariant is absent';
  END IF;
  RAISE NOTICE 'B2A4.6 both policies derive from one predicate, identity invariant present';
END $$;

-- ── 7. The pre-B2A.2 authority must no longer be reachable from a policy ────
DO $$
DECLARE q text;
BEGIN
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO q
    FROM pg_policy pol WHERE pol.polname = 'file_links_select'
     AND pol.polrelid = 'public.file_links'::regclass;
  IF position('wassell_can_access_file' IN q) <> 0 THEN
    RAISE EXCEPTION 'B2A4.7 file_links_select still routes through the pre-B2A.2 decision';
  END IF;
  RAISE NOTICE 'B2A4.7 the side door is closed';
END $$;

SELECT 'B2A.4 smoke: all assertions passed' AS result;
