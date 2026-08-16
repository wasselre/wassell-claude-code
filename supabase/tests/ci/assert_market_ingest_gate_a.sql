-- ============================================================================
-- CI assertions: Gate A market-ingest migrations (2026-09-05_01..04).
-- Run by psql -v ON_ERROR_STOP=1 AFTER
--   supabase/tests/ci/fixture_market_ingest.sql and a SUCCESSFUL in-order
--   apply of the four migrations:
--     supabase/migrations/2026-09-05_01_listing_sources_registry.sql
--     supabase/migrations/2026-09-05_02_raw_capture.sql
--     supabase/migrations/2026-09-05_03_field_catalog_and_gaps.sql
--     supabase/migrations/2026-09-05_04_ingestion_audit.sql
-- The whole file runs inside BEGIN; ... ROLLBACK; so it is re-runnable — the
-- append-only triggers make cleanup-by-DELETE impossible.
-- Every check RAISEs EXCEPTION on failure (fails the psql run) and emits NO
-- row values — only booleans and counts.
-- ============================================================================

BEGIN;

-- Helper: count rows of a Gate A table AS a given role with a given JWT
-- subject.
--
-- ROLE RESTORATION: a bare `SET LOCAL ROLE` inside a function is NOT undone at
-- function exit — PostgreSQL only auto-restores a GUC when the function itself
-- carries a matching SET clause. So this helper resets explicitly before
-- returning, which is what makes each call genuinely self-contained. On the
-- error path (anon, which raises 42501) the RESET is skipped, but the caller's
-- EXCEPTION block is a sub-transaction and its abort rolls the role back — so
-- both paths are covered. Do not delete the RESET on the strength of that:
-- the happy path has no sub-transaction to rely on.
CREATE OR REPLACE FUNCTION public._ci_count_gate_a_as(p_role text, p_uid uuid, p_table text)
RETURNS bigint
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_count bigint;
BEGIN
  PERFORM set_config(
    'request.jwt.claims',
    CASE WHEN p_uid IS NULL THEN '{}'
         ELSE json_build_object('sub', p_uid::text)::text END,
    true
  );
  EXECUTE format('SET LOCAL ROLE %I', p_role);
  EXECUTE format('SELECT count(*) FROM public.%I', p_table) INTO v_count;
  EXECUTE 'RESET ROLE';
  RETURN v_count;
END;
$fn$;

-- Helper: execute p_sql and require it to fail with EXACTLY p_state. A
-- different error is re-raised so it cannot masquerade as a pass; success is
-- converted into an assertion failure (P0001 <> p_state, so it re-raises).
CREATE OR REPLACE FUNCTION public._ci_expect_sqlstate(p_sql text, p_state text, p_label text)
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  EXECUTE p_sql;
  RAISE EXCEPTION 'ASSERT FAILED: % was accepted (expected SQLSTATE %)', p_label, p_state;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE <> p_state THEN RAISE; END IF;
END;
$fn$;

-- == SECTION 1: object inventory, exactly as designed ========================
DO $assert$
DECLARE
  v_tables text[] := ARRAY[
    'listing_sources',
    'raw_blobs', 'raw_snapshots', 'raw_snapshot_artifacts', 'page_capture_manifest',
    'source_field_catalog', 'source_field_mappings', 'schema_gap_events',
    'ingestion_runs', 'ingestion_items', 'listing_change_events', 'listing_change_review'];
  v_functions text[] := ARRAY[
    'public._ml_reject_mutation()',
    'public.raw_snapshot_derive_class(uuid)',
    'public.tg_listing_sources_touch()',
    'public.tg_schema_gap_requires_decision()',
    'public.tg_source_field_catalog_touch()'];
  v_triggers text[] := ARRAY[
    'trg_listing_sources_touch',
    'trg_raw_blobs_immutable', 'trg_raw_snapshots_immutable',
    'trg_raw_snapshot_artifacts_immutable', 'trg_page_capture_manifest_immutable',
    'trg_change_events_immutable',
    'trg_schema_gap_requires_decision',
    'trg_source_field_catalog_touch'];
  v_indexes text[] := ARRAY[
    'ix_raw_snapshots_listing', 'ix_raw_snapshots_class',
    'ix_artifacts_snapshot', 'ix_artifacts_blob',
    'ix_manifest_snapshot', 'ix_manifest_incomplete',
    'ix_catalog_platform', 'ix_gap_open', 'ix_gap_critical', 'ix_mappings_active',
    'ix_items_run', 'ix_items_listing', 'ix_items_state',
    'ix_change_events_record', 'ix_change_events_listing', 'ix_review_open'];
  v_constraints text[] := ARRAY[
    'raw_blobs_exactly_one_location', 'raw_blobs_bucket_with_path',
    'retention_mode_state_consistent', 'artifact_bytes_present_unless_url_only',
    'mapping_field_iff_mapped', 'mapping_reason_required',
    'raw_snapshots_media_summary_obj'];
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class
                    WHERE relnamespace = 'public'::regnamespace
                      AND relname = v_t AND relkind = 'r') THEN
      RAISE EXCEPTION 'ASSERT 1 FAILED: public.% is missing or not an ordinary table', v_t;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE relnamespace = 'public'::regnamespace
                    AND relname = 'v_source_field_status' AND relkind = 'v') THEN
    RAISE EXCEPTION 'ASSERT 1 FAILED: public.v_source_field_status is missing or not a view';
  END IF;

  FOREACH v_t IN ARRAY v_functions LOOP
    IF to_regprocedure(v_t) IS NULL THEN
      RAISE EXCEPTION 'ASSERT 1 FAILED: function % is missing', v_t;
    END IF;
  END LOOP;

  FOREACH v_t IN ARRAY v_triggers LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger tg
                    JOIN pg_class c ON c.oid = tg.tgrelid
                   WHERE c.relnamespace = 'public'::regnamespace
                     AND tg.tgname = v_t AND NOT tg.tgisinternal) THEN
      RAISE EXCEPTION 'ASSERT 1 FAILED: trigger % is missing', v_t;
    END IF;
  END LOOP;

  FOREACH v_t IN ARRAY v_indexes LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      RAISE EXCEPTION 'ASSERT 1 FAILED: index public.% is missing', v_t;
    END IF;
  END LOOP;

  FOREACH v_t IN ARRAY v_constraints LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint co
                    JOIN pg_class c ON c.oid = co.conrelid
                   WHERE c.relnamespace = 'public'::regnamespace
                     AND co.conname = v_t) THEN
      RAISE EXCEPTION 'ASSERT 1 FAILED: named constraint % is missing', v_t;
    END IF;
  END LOOP;

  -- Seed: exactly four sources; aqar is the only active one; nothing may be
  -- publishing-enabled in Gate A (that flip belongs to a later gate).
  IF (SELECT count(*) FROM public.listing_sources) <> 4 THEN
    RAISE EXCEPTION 'ASSERT 1 FAILED: listing_sources seed must be exactly 4 rows, found %',
      (SELECT count(*) FROM public.listing_sources);
  END IF;
  IF (SELECT count(*) FROM public.listing_sources WHERE is_active) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.listing_sources WHERE source_key = 'aqar' AND is_active) THEN
    RAISE EXCEPTION 'ASSERT 1 FAILED: aqar must be the ONLY is_active row in listing_sources';
  END IF;
  IF EXISTS (SELECT 1 FROM public.listing_sources WHERE publishing_enabled) THEN
    RAISE EXCEPTION 'ASSERT 1 FAILED: no listing_sources row may have publishing_enabled = true in Gate A';
  END IF;
END
$assert$;

-- == SECTION 2: RLS enabled on all twelve tables =============================
DO $assert$
DECLARE
  v_tables text[] := ARRAY[
    'listing_sources',
    'raw_blobs', 'raw_snapshots', 'raw_snapshot_artifacts', 'page_capture_manifest',
    'source_field_catalog', 'source_field_mappings', 'schema_gap_events',
    'ingestion_runs', 'ingestion_items', 'listing_change_events', 'listing_change_review'];
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class
                    WHERE relnamespace = 'public'::regnamespace
                      AND relname = v_t AND relkind = 'r' AND relrowsecurity) THEN
      RAISE EXCEPTION 'ASSERT 2 FAILED: RLS is not enabled on public.%', v_t;
    END IF;
  END LOOP;
END
$assert$;

-- == SECTION 3: policy shape — exactly one permissive SELECT to {authenticated}
DO $assert$
DECLARE
  v_tables text[] := ARRAY[
    'listing_sources',
    'raw_blobs', 'raw_snapshots', 'raw_snapshot_artifacts', 'page_capture_manifest',
    'source_field_catalog', 'source_field_mappings', 'schema_gap_events',
    'ingestion_runs', 'ingestion_items', 'listing_change_events', 'listing_change_review'];
  v_t text;
  v_n bigint;
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    SELECT count(*) INTO v_n
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = v_t;
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'ASSERT 3 FAILED: public.% has % policies, expected exactly ONE', v_t, v_n;
    END IF;
    -- polcmd 'r' = SELECT; polpermissive = true; roles exactly {authenticated}.
    -- Matching this single policy also proves no INSERT/UPDATE/DELETE policy
    -- exists (the count above is 1).
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relname = v_t
         AND p.polcmd = 'r'
         AND p.polpermissive
         AND p.polroles::regrole[] = ARRAY['authenticated'::regrole]
    ) THEN
      RAISE EXCEPTION 'ASSERT 3 FAILED: the single policy on public.% is not a PERMISSIVE SELECT to exactly {authenticated}', v_t;
    END IF;
  END LOOP;
END
$assert$;

-- == SECTION 4: grants — exact ACL sets, grantability-aware ==================
-- Asserted via pg_class.relacl + aclexplode, NOT
-- information_schema.role_table_grants, which is blind to MAINTAIN. Each
-- privilege is rendered as privilege_type || '*' when held WITH GRANT OPTION,
-- so a surviving grant option appears as a starred name and fails the exact
-- match instead of passing as plain 'SELECT'.
DO $assert$
DECLARE
  v_objects text[] := ARRAY[
    'listing_sources',
    'raw_blobs', 'raw_snapshots', 'raw_snapshot_artifacts', 'page_capture_manifest',
    'source_field_catalog', 'source_field_mappings', 'schema_gap_events',
    'ingestion_runs', 'ingestion_items', 'listing_change_events', 'listing_change_review',
    'v_source_field_status'];
  v_o text;
  v_acl text;
BEGIN
  FOREACH v_o IN ARRAY v_objects LOOP
    -- anon and PUBLIC (grantee oid 0): zero privileges.
    SELECT coalesce(string_agg(DISTINCT
             (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) || ':' ||
             a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END,
             ', ' ORDER BY
             (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) || ':' ||
             a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
      INTO v_acl
      FROM pg_class c
           CROSS JOIN LATERAL aclexplode(c.relacl) AS a
     WHERE c.oid = format('public.%I', v_o)::regclass
       AND (a.grantee = 0 OR a.grantee = 'anon'::regrole);
    IF v_acl <> '(none)' THEN
      RAISE EXCEPTION 'ASSERT 4 FAILED: anon/PUBLIC must hold zero privileges on public.%, found: %', v_o, v_acl;
    END IF;

    -- authenticated: exactly SELECT, never WITH GRANT OPTION.
    SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
      INTO v_acl
      FROM pg_class c
           CROSS JOIN LATERAL aclexplode(c.relacl) AS a
     WHERE c.oid = format('public.%I', v_o)::regclass
       AND a.grantee = 'authenticated'::regrole;
    IF v_acl <> 'SELECT' THEN
      RAISE EXCEPTION 'ASSERT 4 FAILED: authenticated must hold exactly SELECT on public.%, found: %', v_o, v_acl;
    END IF;

    -- service_role: exactly SELECT, never WITH GRANT OPTION.
    SELECT coalesce(string_agg(DISTINCT a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END, ',' ORDER BY a.privilege_type || CASE WHEN a.is_grantable THEN '*' ELSE '' END), '(none)')
      INTO v_acl
      FROM pg_class c
           CROSS JOIN LATERAL aclexplode(c.relacl) AS a
     WHERE c.oid = format('public.%I', v_o)::regclass
       AND a.grantee = 'service_role'::regrole;
    IF v_acl <> 'SELECT' THEN
      RAISE EXCEPTION 'ASSERT 4 FAILED: service_role must hold exactly SELECT on public.%, found: %', v_o, v_acl;
    END IF;
  END LOOP;
END
$assert$;

-- == SECTION 5: append-only enforcement ======================================
-- The five immutable tables: raw_blobs, raw_snapshots, raw_snapshot_artifacts,
-- page_capture_manifest, listing_change_events. For each: insert a valid row,
-- then BOTH an UPDATE and a DELETE must raise restrict_violation (SQLSTATE
-- 23001) from _ml_reject_mutation, and the row must be unchanged afterwards.
DO $assert$
BEGIN
  -- raw_blobs (via the aqar evidence location; the fixture seeds its target).
  INSERT INTO public.raw_blobs (content_hash, media_type, size_bytes, aqar_evidence_listing_id)
  VALUES (repeat('a', 64), 'text/html', 123, 'fixture-evidence-1');
  PERFORM public._ci_expect_sqlstate(
    $q$UPDATE public.raw_blobs SET media_type = 'text/plain' WHERE content_hash = repeat('a', 64)$q$,
    '23001', 'SECTION 5: UPDATE on raw_blobs');
  PERFORM public._ci_expect_sqlstate(
    $q$DELETE FROM public.raw_blobs WHERE content_hash = repeat('a', 64)$q$,
    '23001', 'SECTION 5: DELETE on raw_blobs');
  IF NOT EXISTS (SELECT 1 FROM public.raw_blobs
                  WHERE content_hash = repeat('a', 64) AND media_type = 'text/html') THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: raw_blobs row was mutated or removed despite the append-only trigger';
  END IF;

  -- raw_snapshots.
  INSERT INTO public.raw_snapshots (id, source, external_id, capture_class, adapter_id, adapter_version, manifest_hash)
  VALUES ('50000000-0000-0000-0000-000000000051', 'aqar', 'ci-s5-snapshot', 'complete', 'ci-adapter', 'v001', repeat('c', 64));
  PERFORM public._ci_expect_sqlstate(
    $q$UPDATE public.raw_snapshots SET capture_class = 'partial' WHERE id = '50000000-0000-0000-0000-000000000051'$q$,
    '23001', 'SECTION 5: UPDATE on raw_snapshots');
  PERFORM public._ci_expect_sqlstate(
    $q$DELETE FROM public.raw_snapshots WHERE id = '50000000-0000-0000-0000-000000000051'$q$,
    '23001', 'SECTION 5: DELETE on raw_snapshots');
  IF NOT EXISTS (SELECT 1 FROM public.raw_snapshots
                  WHERE id = '50000000-0000-0000-0000-000000000051' AND capture_class = 'complete') THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: raw_snapshots row was mutated or removed despite the append-only trigger';
  END IF;

  -- raw_snapshot_artifacts (url-only: content_hash legitimately NULL).
  INSERT INTO public.raw_snapshot_artifacts
    (id, snapshot_id, artifact_type, source_url_or_endpoint, retention_mode, retention_state)
  VALUES ('50000000-0000-0000-0000-000000000071', '50000000-0000-0000-0000-000000000051',
          'detail_html', 'https://example.test/detail', 'source_url_metadata_only', 'external_reference_only');
  PERFORM public._ci_expect_sqlstate(
    $q$UPDATE public.raw_snapshot_artifacts SET retention_state = 'not_applicable' WHERE id = '50000000-0000-0000-0000-000000000071'$q$,
    '23001', 'SECTION 5: UPDATE on raw_snapshot_artifacts');
  PERFORM public._ci_expect_sqlstate(
    $q$DELETE FROM public.raw_snapshot_artifacts WHERE id = '50000000-0000-0000-0000-000000000071'$q$,
    '23001', 'SECTION 5: DELETE on raw_snapshot_artifacts');
  IF NOT EXISTS (SELECT 1 FROM public.raw_snapshot_artifacts
                  WHERE id = '50000000-0000-0000-0000-000000000071'
                    AND retention_state = 'external_reference_only') THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: raw_snapshot_artifacts row was mutated or removed despite the append-only trigger';
  END IF;

  -- page_capture_manifest.
  INSERT INTO public.page_capture_manifest (snapshot_id, section, state, why_expected)
  VALUES ('50000000-0000-0000-0000-000000000051', 'images', 'captured', 'source_reported_count');
  PERFORM public._ci_expect_sqlstate(
    $q$UPDATE public.page_capture_manifest SET state = 'unknown' WHERE snapshot_id = '50000000-0000-0000-0000-000000000051' AND section = 'images'$q$,
    '23001', 'SECTION 5: UPDATE on page_capture_manifest');
  PERFORM public._ci_expect_sqlstate(
    $q$DELETE FROM public.page_capture_manifest WHERE snapshot_id = '50000000-0000-0000-0000-000000000051' AND section = 'images'$q$,
    '23001', 'SECTION 5: DELETE on page_capture_manifest');
  IF NOT EXISTS (SELECT 1 FROM public.page_capture_manifest
                  WHERE snapshot_id = '50000000-0000-0000-0000-000000000051'
                    AND section = 'images' AND state = 'captured') THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: page_capture_manifest row was mutated or removed despite the append-only trigger';
  END IF;

  -- listing_change_events (record_id deliberately carries no FK — the audit
  -- must survive a listing deletion).
  INSERT INTO public.listing_change_events (id, record_id, source, external_id, kind, reason, diff)
  VALUES ('50000000-0000-0000-0000-000000000091', '50000000-0000-0000-0000-000000000081',
          'aqar', 'ci-s5-snapshot', 'manual_edit', 'ci-s5', '{"price":{"before":1,"after":2}}'::jsonb);
  PERFORM public._ci_expect_sqlstate(
    $q$UPDATE public.listing_change_events SET reason = 'MUTATED' WHERE id = '50000000-0000-0000-0000-000000000091'$q$,
    '23001', 'SECTION 5: UPDATE on listing_change_events');
  PERFORM public._ci_expect_sqlstate(
    $q$DELETE FROM public.listing_change_events WHERE id = '50000000-0000-0000-0000-000000000091'$q$,
    '23001', 'SECTION 5: DELETE on listing_change_events');
  IF NOT EXISTS (SELECT 1 FROM public.listing_change_events
                  WHERE id = '50000000-0000-0000-0000-000000000091' AND reason = 'ci-s5') THEN
    RAISE EXCEPTION 'ASSERT 5 FAILED: listing_change_events row was mutated or removed despite the append-only trigger';
  END IF;
END
$assert$;

-- == SECTION 6: capture-state model (all seven states) =======================
-- Between them the inserts below exercise every designed state value:
-- captured, not_present, not_applicable, missing_expected, unknown, failed,
-- blocked. Derivation precedence is blocked > failed > partial > complete.
DO $assert$
BEGIN
  INSERT INTO public.raw_snapshots (id, source, external_id, capture_class, adapter_id, adapter_version, manifest_hash) VALUES
    ('50000000-0000-0000-0000-000000000061', 'aqar', 'ci-s6-complete',        'complete', 'ci-adapter', 'v001', repeat('d', 64)),
    ('50000000-0000-0000-0000-000000000062', 'aqar', 'ci-s6-partial-missing', 'partial',  'ci-adapter', 'v001', repeat('e', 64)),
    ('50000000-0000-0000-0000-000000000063', 'aqar', 'ci-s6-partial-unknown', 'partial',  'ci-adapter', 'v001', repeat('f', 64)),
    ('50000000-0000-0000-0000-000000000064', 'aqar', 'ci-s6-failed',          'failed',   'ci-adapter', 'v001', repeat('1', 64)),
    ('50000000-0000-0000-0000-000000000065', 'aqar', 'ci-s6-blocked',         'blocked',  'ci-adapter', 'v001', repeat('2', 64)),
    ('50000000-0000-0000-0000-000000000066', 'aqar', 'ci-s6-nonsense-target', 'complete', 'ci-adapter', 'v001', repeat('5', 64));

  INSERT INTO public.page_capture_manifest (snapshot_id, section, state, why_expected) VALUES
    -- captured + not_present + not_applicable only.
    ('50000000-0000-0000-0000-000000000061', 'images',      'captured',       'source_reported_count'),
    ('50000000-0000-0000-0000-000000000061', 'videos',      'not_present',    'none'),
    ('50000000-0000-0000-0000-000000000061', 'floor_plans', 'not_applicable', 'none'),
    -- ... plus missing_expected.
    ('50000000-0000-0000-0000-000000000062', 'images',      'captured',         'source_reported_count'),
    ('50000000-0000-0000-0000-000000000062', 'detail_api',  'missing_expected', 'api_reference'),
    -- ... plus unknown.
    ('50000000-0000-0000-0000-000000000063', 'images',      'captured', 'source_reported_count'),
    ('50000000-0000-0000-0000-000000000063', 'features',    'unknown',  'platform_contract'),
    -- ... plus failed.
    ('50000000-0000-0000-0000-000000000064', 'images',      'captured', 'source_reported_count'),
    ('50000000-0000-0000-0000-000000000064', 'permit_api',  'failed',   'api_reference'),
    -- blocked AND failed together (precedence probe).
    ('50000000-0000-0000-0000-000000000065', 'images',      'blocked',  'tab'),
    ('50000000-0000-0000-0000-000000000065', 'permit_api',  'failed',   'api_reference');

  -- HEADLINE INVARIANT: optional absence (not_present / not_applicable) does
  -- NOT reduce completeness.
  IF public.raw_snapshot_derive_class('50000000-0000-0000-0000-000000000061') IS DISTINCT FROM 'complete' THEN
    RAISE EXCEPTION 'ASSERT 6 FAILED: captured+not_present+not_applicable must derive ''complete'' (optional absence must not reduce completeness)';
  END IF;
  IF public.raw_snapshot_derive_class('50000000-0000-0000-0000-000000000062') IS DISTINCT FROM 'partial' THEN
    RAISE EXCEPTION 'ASSERT 6 FAILED: a manifest containing missing_expected must derive ''partial''';
  END IF;
  IF public.raw_snapshot_derive_class('50000000-0000-0000-0000-000000000063') IS DISTINCT FROM 'partial' THEN
    RAISE EXCEPTION 'ASSERT 6 FAILED: a manifest containing unknown must derive ''partial''';
  END IF;
  IF public.raw_snapshot_derive_class('50000000-0000-0000-0000-000000000064') IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'ASSERT 6 FAILED: a manifest containing failed must derive ''failed''';
  END IF;
  IF public.raw_snapshot_derive_class('50000000-0000-0000-0000-000000000065') IS DISTINCT FROM 'blocked' THEN
    RAISE EXCEPTION 'ASSERT 6 FAILED: blocked must take precedence over failed (blocked+failed must derive ''blocked'')';
  END IF;

  -- An eighth value is rejected by the CHECK (check_violation = 23514).
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.page_capture_manifest (snapshot_id, section, state, why_expected)
       VALUES ('50000000-0000-0000-0000-000000000066', 'images', 'nonsense', 'none')$q$,
    '23514', 'SECTION 6: page_capture_manifest.state value ''nonsense'' (the CHECK accepts exactly the seven designed states)');
END
$assert$;

-- == SECTION 7: retention model (independent axis) ===========================
-- Capture state (page_capture_manifest.state) and retention state are
-- INDEPENDENT axes: retention_mode is the MECHANISM used to retain the asset,
-- retention_state is the durability OUTCOME. Neither CHECK references the
-- capture manifest.
DO $assert$
DECLARE
  v_snap uuid := '50000000-0000-0000-0000-000000000061';
BEGIN
  -- ACCEPTED mode+state pairs (content_hash supplied wherever the artifact is
  -- not url-only; the blob was inserted in SECTION 5). The url-only row with
  -- NULL content_hash doubles as the accepted half of
  -- artifact_bytes_present_unless_url_only.
  INSERT INTO public.raw_snapshot_artifacts (snapshot_id, artifact_type, retention_mode, retention_state, content_hash) VALUES
    (v_snap, 'image', 'existing_storage_ref',     'durable_existing_asset',   repeat('a', 64)),
    (v_snap, 'image', 'original_bytes',           'durable_original',         repeat('a', 64)),
    (v_snap, 'image', 'immutable_mirror',         'durable_original',         repeat('a', 64)),
    (v_snap, 'video', 'manifest_and_segments',    'retention_failed',         repeat('a', 64)),
    (v_snap, 'video', 'source_url_metadata_only', 'external_reference_only',  NULL);

  -- REJECTED pairs (retention_mode_state_consistent, check_violation = 23514).
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.raw_snapshot_artifacts (snapshot_id, artifact_type, retention_mode, retention_state, content_hash)
       VALUES ('50000000-0000-0000-0000-000000000061', 'image', 'existing_storage_ref', 'durable_original', repeat('a', 64))$q$,
    '23514', 'SECTION 7: retention pair existing_storage_ref+durable_original');
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.raw_snapshot_artifacts (snapshot_id, artifact_type, retention_mode, retention_state, content_hash)
       VALUES ('50000000-0000-0000-0000-000000000061', 'image', 'source_url_metadata_only', 'durable_original', NULL)$q$,
    '23514', 'SECTION 7: retention pair source_url_metadata_only+durable_original');
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.raw_snapshot_artifacts (snapshot_id, artifact_type, retention_mode, retention_state, content_hash)
       VALUES ('50000000-0000-0000-0000-000000000061', 'image', 'original_bytes', 'external_reference_only', repeat('a', 64))$q$,
    '23514', 'SECTION 7: retention pair original_bytes+external_reference_only');

  -- artifact_bytes_present_unless_url_only: a non-url-only artifact with NULL
  -- content_hash is rejected.
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.raw_snapshot_artifacts (snapshot_id, artifact_type, retention_mode, retention_state, content_hash)
       VALUES ('50000000-0000-0000-0000-000000000061', 'image', 'original_bytes', 'durable_original', NULL)$q$,
    '23514', 'SECTION 7: non-url-only artifact with NULL content_hash (artifact_bytes_present_unless_url_only)');
END
$assert$;

-- == SECTION 8: raw_blobs location invariants ================================
DO $assert$
BEGIN
  -- raw_blobs_exactly_one_location: neither location set is rejected.
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.raw_blobs (content_hash, media_type, size_bytes)
       VALUES (repeat('6', 64), 'text/html', 1)$q$,
    '23514', 'SECTION 8: raw_blobs row with NEITHER storage location (raw_blobs_exactly_one_location)');
  -- ... both locations set is rejected.
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.raw_blobs (content_hash, media_type, size_bytes, storage_bucket, storage_object_path, aqar_evidence_listing_id)
       VALUES (repeat('7', 64), 'text/html', 1, 'listing-photos', 'x/y.html', 'fixture-evidence-1')$q$,
    '23514', 'SECTION 8: raw_blobs row with BOTH storage locations (raw_blobs_exactly_one_location)');
  -- ... exactly one is accepted (the aqar-evidence-only shape was accepted in
  -- SECTION 5; here the storage-path-only shape).
  INSERT INTO public.raw_blobs (content_hash, media_type, size_bytes, storage_bucket, storage_object_path)
  VALUES (repeat('3', 64), 'text/html', 1, 'listing-photos', 'x/z.html');

  -- raw_blobs_bucket_with_path: a path with a NULL bucket is rejected.
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.raw_blobs (content_hash, media_type, size_bytes, storage_object_path)
       VALUES (repeat('4', 64), 'text/html', 1, 'x/w.html')$q$,
    '23514', 'SECTION 8: raw_blobs row with storage_object_path but NULL bucket (raw_blobs_bucket_with_path)');

  -- content_hash must be sha256 hex (location kept valid so the regex CHECK
  -- is the one under test).
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.raw_blobs (content_hash, media_type, size_bytes, storage_bucket, storage_object_path)
       VALUES ('not-a-sha256', 'text/html', 1, 'listing-photos', 'x/bad.html')$q$,
    '23514', 'SECTION 8: raw_blobs content_hash that is not sha256 hex');
END
$assert$;

-- == SECTION 9: governance — mappings are the sole authority =================
DO $assert$
BEGIN
  -- gap -> 'resolved' with NO mapping row: REJECTED (the trigger raises
  -- check_violation = 23514).
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.schema_gap_events (platform, source_path, contract_version, status)
       VALUES ('aqar', 'ci.g9.no_mapping', 'v001', 'resolved')$q$,
    '23514', 'SECTION 9: gap resolved with NO source_field_mappings row');

  -- gap -> 'resolved' with mapping status 'review_required': REJECTED.
  INSERT INTO public.source_field_mappings (platform, source_path, contract_version, status)
  VALUES ('aqar', 'ci.g9.review_required', 'v001', 'review_required');
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.schema_gap_events (platform, source_path, contract_version, status)
       VALUES ('aqar', 'ci.g9.review_required', 'v001', 'resolved')$q$,
    '23514', 'SECTION 9: gap resolved while the mapping is review_required');

  -- gap -> 'resolved' with mapping status 'unresolved': REJECTED.
  INSERT INTO public.source_field_mappings (platform, source_path, contract_version, status)
  VALUES ('aqar', 'ci.g9.unresolved', 'v001', 'unresolved');
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.schema_gap_events (platform, source_path, contract_version, status)
       VALUES ('aqar', 'ci.g9.unresolved', 'v001', 'resolved')$q$,
    '23514', 'SECTION 9: gap resolved while the mapping is unresolved');

  -- gap -> 'resolved' with mapping status 'mapped_existing_field': ACCEPTED.
  INSERT INTO public.source_field_mappings (platform, source_path, contract_version, status, canonical_field)
  VALUES ('aqar', 'ci.g9.mapped', 'v001', 'mapped_existing_field', 'price');
  INSERT INTO public.schema_gap_events (platform, source_path, contract_version, status)
  VALUES ('aqar', 'ci.g9.mapped', 'v001', 'resolved');

  -- gap -> 'wont_map' with mapping status 'intentionally_ignored': ACCEPTED.
  INSERT INTO public.source_field_mappings (platform, source_path, contract_version, status, reviewer, reason, decided_at)
  VALUES ('aqar', 'ci.g9.ignored', 'v001', 'intentionally_ignored', 'ci-reviewer', 'not part of the canonical model', now());
  INSERT INTO public.schema_gap_events (platform, source_path, contract_version, status)
  VALUES ('aqar', 'ci.g9.ignored', 'v001', 'wont_map');

  -- mapping_field_iff_mapped, both directions.
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.source_field_mappings (platform, source_path, contract_version, status)
       VALUES ('aqar', 'ci.g9.iff_missing_field', 'v001', 'mapped_existing_field')$q$,
    '23514', 'SECTION 9: mapped_existing_field with NULL canonical_field (mapping_field_iff_mapped)');
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.source_field_mappings (platform, source_path, contract_version, status, canonical_field)
       VALUES ('aqar', 'ci.g9.iff_stray_field', 'v001', 'review_required', 'price')$q$,
    '23514', 'SECTION 9: non-mapped status with a non-null canonical_field (mapping_field_iff_mapped)');

  -- mapping_reason_required: intentionally_ignored without reviewer / reason /
  -- decided_at is rejected.
  PERFORM public._ci_expect_sqlstate(
    $q$INSERT INTO public.source_field_mappings (platform, source_path, contract_version, status)
       VALUES ('aqar', 'ci.g9.reason_missing', 'v001', 'intentionally_ignored')$q$,
    '23514', 'SECTION 9: intentionally_ignored missing reviewer/reason/decided_at (mapping_reason_required)');

  -- The catalog must remain discovery-only evidence: NO column whose name
  -- contains 'status' — it holds no mapping decision.
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.source_field_catalog'::regclass
                AND attnum > 0 AND NOT attisdropped
                AND attname ILIKE '%status%') THEN
    RAISE EXCEPTION 'ASSERT 9 FAILED: source_field_catalog has a status-bearing column; the catalog must remain discovery-only evidence and hold no mapping decision (decisions live in source_field_mappings)';
  END IF;
END
$assert$;

-- == SECTION 10: the reconciled view =========================================
DO $assert$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.v_source_field_status'::regclass
                    AND reloptions @> ARRAY['security_invoker=true']) THEN
    RAISE EXCEPTION 'ASSERT 10 FAILED: v_source_field_status must have reloptions security_invoker=true';
  END IF;

  -- A catalog row with no mapping row surfaces authoritative_status 'unresolved'.
  INSERT INTO public.source_field_catalog (platform, adapter_id, contract_version, source_path)
  VALUES ('aqar', 'ci-adapter', 'v001', 'ci.s10.unmapped');
  IF (SELECT v.authoritative_status
        FROM public.v_source_field_status v
       WHERE v.platform = 'aqar' AND v.source_path = 'ci.s10.unmapped') IS DISTINCT FROM 'unresolved' THEN
    RAISE EXCEPTION 'ASSERT 10 FAILED: a catalog row with no mapping must surface authoritative_status = ''unresolved''';
  END IF;
END
$assert$;

-- == SECTION 11: market_listings independence (the split is real) ============
DO $assert$
DECLARE
  v_tables text[] := ARRAY[
    'listing_sources',
    'raw_blobs', 'raw_snapshots', 'raw_snapshot_artifacts', 'page_capture_manifest',
    'source_field_catalog', 'source_field_mappings', 'schema_gap_events',
    'ingestion_runs', 'ingestion_items', 'listing_change_events', 'listing_change_review'];
BEGIN
  -- It must STILL not exist after all four migrations.
  IF to_regclass('public.market_listings') IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT 11 FAILED: public.market_listings exists after the Gate A migrations; the Gate A set must not create it and must not depend on it';
  END IF;

  -- No FK on any of the twelve tables references a relation named
  -- market_listings.
  IF EXISTS (SELECT 1 FROM pg_constraint co
               JOIN pg_class c  ON c.oid  = co.conrelid
               JOIN pg_class fc ON fc.oid = co.confrelid
              WHERE co.contype = 'f'
                AND c.relnamespace = 'public'::regnamespace
                AND c.relname = ANY (v_tables)
                AND fc.relname = 'market_listings') THEN
    RAISE EXCEPTION 'ASSERT 11 FAILED: a Gate A table carries a foreign key to market_listings; the Gate A set must not depend on it';
  END IF;

  -- No Gate A function body mentions market_listings (case-insensitive).
  IF EXISTS (SELECT 1 FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('_ml_reject_mutation', 'raw_snapshot_derive_class',
                                  'tg_listing_sources_touch', 'tg_schema_gap_requires_decision',
                                  'tg_source_field_catalog_touch')
                AND pg_get_functiondef(p.oid) ~* 'market_listings') THEN
    RAISE EXCEPTION 'ASSERT 11 FAILED: a Gate A function body references market_listings; the Gate A set must not depend on it';
  END IF;

  -- No trigger or rule anywhere in public targets a relation named
  -- market_listings.
  IF EXISTS (SELECT 1 FROM pg_trigger t
               JOIN pg_class c ON c.oid = t.tgrelid
              WHERE c.relnamespace = 'public'::regnamespace
                AND c.relname = 'market_listings')
     OR EXISTS (SELECT 1 FROM pg_rewrite r
                  JOIN pg_class c ON c.oid = r.ev_class
                 WHERE c.relnamespace = 'public'::regnamespace
                   AND c.relname = 'market_listings') THEN
    RAISE EXCEPTION 'ASSERT 11 FAILED: a trigger or rule in public targets market_listings; the Gate A set must not depend on it';
  END IF;

  -- The deferred tables belong to 2026-09-05_06, after the freeze baseline.
  IF to_regclass('public.listing_field_provenance') IS NOT NULL
     OR to_regclass('public.mirror_outbox') IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT 11 FAILED: listing_field_provenance / mirror_outbox must NOT exist; they belong to the deferred 2026-09-05_06 and must arrive only after the freeze baseline';
  END IF;
END
$assert$;

-- == SECTION 12: no Storage objects created ==================================
-- Storage enforcement is deferred to Gate B; the CI database has no storage
-- schema at all, so the storage-side checks guard with to_regclass and are a
-- clean no-op here — they exist to catch a migration that starts creating the
-- bucket/policies (they would then fire against a real Supabase database).
DO $assert$
DECLARE
  v_bad boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'market_raw_uploader') THEN
    RAISE EXCEPTION 'ASSERT 12 FAILED: role market_raw_uploader exists; Storage enforcement is deferred to Gate B';
  END IF;

  IF to_regclass('storage.buckets') IS NOT NULL THEN
    EXECUTE $q$SELECT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'market-raw')$q$
      INTO v_bad;
    IF v_bad THEN
      RAISE EXCEPTION 'ASSERT 12 FAILED: storage bucket market-raw exists; Storage enforcement is deferred to Gate B';
    END IF;
  END IF;

  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE $q$SELECT EXISTS (SELECT 1 FROM pg_policy
                               WHERE polrelid = 'storage.objects'::regclass
                                 AND polname IN ('market_raw_upload', 'market_raw_admin_read'))$q$
      INTO v_bad;
    IF v_bad THEN
      RAISE EXCEPTION 'ASSERT 12 FAILED: a market_raw_upload / market_raw_admin_read policy exists on storage.objects; Storage enforcement is deferred to Gate B';
    END IF;
  END IF;
END
$assert$;

-- == SECTION 13: no scoring or ranking =======================================
-- Scoring is explicitly out of phase. Asserted on OBJECT NAMES only — the
-- word may legitimately appear in prose comments, which are not inspected.
DO $assert$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class
              WHERE relnamespace = 'public'::regnamespace
                AND relname ~* '(score|rank|quality)') THEN
    RAISE EXCEPTION 'ASSERT 13 FAILED: a relation/index in public has a name containing score/rank/quality; scoring is out of phase for Gate A';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute a
               JOIN pg_class c ON c.oid = a.attrelid
              WHERE c.relnamespace = 'public'::regnamespace
                AND a.attnum > 0 AND NOT a.attisdropped
                AND a.attname ~* '(score|rank|quality)') THEN
    RAISE EXCEPTION 'ASSERT 13 FAILED: a column in public has a name containing score/rank/quality; scoring is out of phase for Gate A';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname ~* '(score|rank|quality)') THEN
    RAISE EXCEPTION 'ASSERT 13 FAILED: a function in public has a name containing score/rank/quality; scoring is out of phase for Gate A';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint co
               JOIN pg_class c ON c.oid = co.conrelid
              WHERE c.relnamespace = 'public'::regnamespace
                AND co.conname ~* '(score|rank|quality)') THEN
    RAISE EXCEPTION 'ASSERT 13 FAILED: a constraint in public has a name containing score/rank/quality; scoring is out of phase for Gate A';
  END IF;
END
$assert$;

-- == SECTION 14: RLS behavioural matrix (four identities) ====================
-- One table per family: listing_sources (registry), raw_snapshots (raw
-- capture), schema_gap_events (governance/audit). Identities: authenticated as
-- the fixture ADMIN, authenticated as the fixture NON-ADMIN, service_role
-- (BYPASSRLS), and anon (no privilege at all — a zero-row result for anon is a
-- FAILURE: the requirement is permission denied, not an empty result).
DO $assert$
DECLARE
  v_tables   text[] := ARRAY['listing_sources', 'raw_snapshots', 'schema_gap_events'];
  v_t        text;
  v_count    bigint;
  v_admin    uuid := '11111111-1111-1111-1111-111111111111';
  v_nonadmin uuid := '22222222-2222-2222-2222-222222222222';
BEGIN
  FOREACH v_t IN ARRAY v_tables LOOP
    -- authenticated as ADMIN: sees rows (listing_sources: exactly the 4 seeds).
    v_count := public._ci_count_gate_a_as('authenticated', v_admin, v_t);
    IF v_t = 'listing_sources' AND v_count <> 4 THEN
      RAISE EXCEPTION 'ASSERT 14 FAILED: authenticated ADMIN saw % listing_sources rows, expected exactly 4', v_count;
    ELSIF v_t <> 'listing_sources' AND v_count < 1 THEN
      RAISE EXCEPTION 'ASSERT 14 FAILED: authenticated ADMIN saw 0 rows on public.%, expected the rows inserted by these assertions', v_t;
    END IF;

    -- authenticated as NON-ADMIN: 0 rows (admin-only read policy).
    v_count := public._ci_count_gate_a_as('authenticated', v_nonadmin, v_t);
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'ASSERT 14 FAILED: authenticated NON-ADMIN saw % rows on public.%, expected 0', v_count, v_t;
    END IF;

    -- service_role: sees rows (BYPASSRLS, pinned by the fixture).
    v_count := public._ci_count_gate_a_as('service_role', NULL, v_t);
    IF v_t = 'listing_sources' AND v_count <> 4 THEN
      RAISE EXCEPTION 'ASSERT 14 FAILED: service_role saw % listing_sources rows, expected exactly 4', v_count;
    ELSIF v_t <> 'listing_sources' AND v_count < 1 THEN
      RAISE EXCEPTION 'ASSERT 14 FAILED: service_role saw 0 rows on public.% (BYPASSRLS must see everything)', v_t;
    END IF;

    -- anon: permission denied, SQLSTATE 42501 (insufficient_privilege).
    BEGIN
      PERFORM public._ci_count_gate_a_as('anon', NULL, v_t);
      RAISE EXCEPTION 'ASSERT 14 FAILED: anon SELECT on public.% did not raise insufficient_privilege — a zero-row result is a FAILURE here; the requirement is no privilege (SQLSTATE 42501), not an empty result', v_t;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL; -- expected
    END;
  END LOOP;

  RAISE NOTICE 'Gate A market-ingest assertions: ALL PASSED';
END
$assert$;

ROLLBACK;
