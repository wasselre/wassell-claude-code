-- ============================================================================
-- Phase 2 · Aqar ingestion · 01 · Shared ingestion WRITE-PATH (definer RPCs)
-- IDEMPOTENT: safe to re-apply (verified by CI).
-- ----------------------------------------------------------------------------
-- OWNER/PURPOSE: Gate A shipped the ingestion/evidence/governance tables with
-- ZERO write grants to any application role — every table is admin-SELECT-only
-- and writes were reserved for "owner-run definer RPCs, not yet built"
-- (docs/market-ingest/gate-a.md §13). This migration builds that write path for
-- the CAPTURE half of the pipeline (the canonical PUBLISHER into market_listings
-- is a separate migration, 2026-09-06_02).
--
-- All RPCs are SECURITY DEFINER (run as owner `postgres`, which owns the Gate A
-- tables and holds BYPASSRLS), SET search_path, and are EXECUTE-granted to
-- `service_role` ONLY — the worker runtime. anon/authenticated/PUBLIC cannot
-- call them. The append-only triggers on the raw_* / change-event tables are
-- untouched: these RPCs only INSERT into them, never UPDATE/DELETE.
--
-- IDEMPOTENCY (deterministic on retry — a hard requirement):
--   * raw_blobs         — content-addressed PK; ON CONFLICT DO NOTHING.
--   * raw_snapshots     — UNIQUE(source,external_id,manifest_hash); a re-captured
--                         identical page resolves to the SAME snapshot and its
--                         child artifacts/manifest are inserted exactly once.
--   * ingestion_items   — UNIQUE(run_id,source,external_id); upserted.
--   * source_field_catalog / schema_gap_events — upserted on their natural keys.
--
-- SCOPE: creates functions only. Creates NO table, touches NO grant on any Gate A
-- table, NO market_listings, NO worker, NO scoring/ranking. Parsing/mapping is
-- deterministic and lives in the adapter; these RPCs are pure persistence.
-- FORWARD RECOVERY: DROP the functions; no data is altered by their removal.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout      = '5s';
SET LOCAL statement_timeout = '60s';

-- Fail-closed dependency preflight -------------------------------------------
DO $preflight$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(n, ', ' ORDER BY n) INTO v_missing
    FROM unnest(ARRAY[
      'listing_sources','raw_blobs','raw_snapshots','raw_snapshot_artifacts','page_capture_manifest',
      'source_field_catalog','source_field_mappings','schema_gap_events',
      'ingestion_runs','ingestion_items']) AS n
   WHERE to_regclass('public.'||n) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: Gate A table(s) absent: %. Apply 2026-09-05_01..04 first.', v_missing;
  END IF;
END $preflight$;

-- ── internal helpers (bounded de-duplicating unions; not granted to anyone) ──
-- Called only from inside the definer RPCs below, which run as owner, so no
-- caller ever needs EXECUTE on them.

CREATE OR REPLACE FUNCTION public._ingest_derive_class(p_manifest jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  -- Same precedence as public.raw_snapshot_derive_class, evaluated on the JSON
  -- manifest before insert. Empty manifest ⇒ 'complete'.
  SELECT CASE
    WHEN bool_or(state = 'blocked') THEN 'blocked'
    WHEN bool_or(state = 'failed')  THEN 'failed'
    WHEN bool_or(state IN ('missing_expected','unknown')) THEN 'partial'
    ELSE 'complete'
  END
  FROM (SELECT elem->>'state' AS state
          FROM jsonb_array_elements(coalesce(p_manifest,'[]'::jsonb)) elem) s;
$$;

CREATE OR REPLACE FUNCTION public._jsonb_bounded_union(a jsonb, b jsonb, n int)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  WITH vals AS (
    SELECT v, min(ord) AS ord FROM (
      SELECT value AS v, row_number() OVER () AS ord
        FROM jsonb_array_elements(coalesce(a,'[]'::jsonb))
      UNION ALL
      SELECT value AS v, 1000000 + row_number() OVER () AS ord
        FROM jsonb_array_elements(coalesce(b,'[]'::jsonb))
    ) x GROUP BY v
  )
  SELECT coalesce(jsonb_agg(v ORDER BY ord), '[]'::jsonb)
    FROM (SELECT v, ord FROM vals ORDER BY ord LIMIT greatest(n,0)) z;
$$;

CREATE OR REPLACE FUNCTION public._uuid_bounded_union(a uuid[], b uuid[], n int)
RETURNS uuid[] LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  WITH vals AS (
    SELECT u, min(ord) AS ord FROM (
      SELECT u, row_number() OVER () AS ord
        FROM unnest(coalesce(a,'{}'::uuid[])) AS u
      UNION ALL
      SELECT u, 1000000 + row_number() OVER () AS ord
        FROM unnest(coalesce(b,'{}'::uuid[])) AS u
    ) x GROUP BY u
  )
  SELECT coalesce((array_agg(u ORDER BY ord))[1:greatest(n,0)], '{}'::uuid[]) FROM vals;
$$;

-- ── 1. ingestion_run_start ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ingestion_run_start(p_source text, p_adapter_version text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid; v_active boolean;
BEGIN
  IF p_adapter_version IS NULL OR btrim(p_adapter_version) = '' THEN
    RAISE EXCEPTION 'ingestion_run_start: adapter_version is required';
  END IF;
  SELECT is_active INTO v_active FROM public.listing_sources WHERE source_key = p_source;
  IF v_active IS NULL THEN
    RAISE EXCEPTION 'ingestion_run_start: unknown source %', p_source USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'ingestion_run_start: source % is not active', p_source USING ERRCODE = 'raise_exception';
  END IF;
  INSERT INTO public.ingestion_runs (source, adapter_version) VALUES (p_source, p_adapter_version)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION public.ingestion_run_start(text,text) IS 'Phase2: open an ingestion run for an active source; returns run id. service_role-only.';

-- ── 2. ingestion_item_set_state ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ingestion_item_set_state(
  p_run_id uuid, p_source text, p_external_id text, p_state text, p_error text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid;
BEGIN
  -- state validity is enforced by the ingestion_items CHECK; surface a named error early.
  IF p_state IS NULL THEN RAISE EXCEPTION 'ingestion_item_set_state: state is required'; END IF;
  INSERT INTO public.ingestion_items (run_id, source, external_id, state, error, fetched_at)
  VALUES (p_run_id, p_source, p_external_id, p_state, p_error,
          CASE WHEN p_state = 'fetched' THEN now() ELSE NULL END)
  ON CONFLICT (run_id, source, external_id) DO UPDATE
    SET state      = EXCLUDED.state,
        error      = EXCLUDED.error,
        fetched_at = CASE WHEN EXCLUDED.state = 'fetched' THEN now()
                          ELSE public.ingestion_items.fetched_at END
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION public.ingestion_item_set_state(uuid,text,text,text,text) IS 'Phase2: upsert an ingestion item to a lifecycle state. service_role-only.';

-- ── 3. ingest_capture_put — atomic, idempotent capture writer ────────────────
-- Persists one immutable capture (blobs + snapshot + artifacts + section
-- manifest) and advances the item to raw_snapshot_saved. Idempotent at the
-- snapshot grain: an identical re-capture (same source/external_id/manifest_hash)
-- resolves to the existing snapshot and inserts NO duplicate children.
--
-- p_blobs     : [{content_hash,media_type,size_bytes,storage_bucket,storage_object_path,aqar_evidence_listing_id}]
-- p_artifacts : [{artifact_type,media_type,source_url_or_endpoint,content_hash,retention_mode,retention_state,
--                 http_status,parser_hint,completeness,order_index,caption,width,height,duration_seconds,media_metadata}]
-- p_manifest  : [{section,state,why_expected,artifact_index (0-based into p_artifacts, or null),note}]
CREATE OR REPLACE FUNCTION public.ingest_capture_put(
  p_run_id uuid, p_source text, p_external_id text,
  p_adapter_id text, p_adapter_version text, p_manifest_hash text,
  p_media_summary jsonb, p_blobs jsonb, p_artifacts jsonb, p_manifest jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_run_source  text;
  v_snapshot_id uuid;
  v_was_new     boolean := false;
  v_class       text;
  v_artifact_ids uuid[] := '{}';
  v_aid         uuid;
  b jsonb; r record; m jsonb;
BEGIN
  IF p_adapter_id IS NULL OR btrim(p_adapter_id) = '' THEN RAISE EXCEPTION 'ingest_capture_put: adapter_id required'; END IF;
  IF p_adapter_version IS NULL OR btrim(p_adapter_version) = '' THEN RAISE EXCEPTION 'ingest_capture_put: adapter_version required'; END IF;
  IF coalesce(p_manifest_hash,'') !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'ingest_capture_put: manifest_hash must be sha256 hex'; END IF;

  SELECT source INTO v_run_source FROM public.ingestion_runs WHERE id = p_run_id;
  IF v_run_source IS NULL THEN RAISE EXCEPTION 'ingest_capture_put: unknown run %', p_run_id USING ERRCODE='foreign_key_violation'; END IF;
  IF v_run_source <> p_source THEN RAISE EXCEPTION 'ingest_capture_put: run % belongs to source %, not %', p_run_id, v_run_source, p_source; END IF;

  -- (1) content-addressed blobs, deduped
  FOR b IN SELECT value FROM jsonb_array_elements(coalesce(p_blobs,'[]'::jsonb)) LOOP
    INSERT INTO public.raw_blobs (content_hash, media_type, size_bytes, storage_bucket, storage_object_path, aqar_evidence_listing_id)
    VALUES (b->>'content_hash', b->>'media_type', (b->>'size_bytes')::bigint,
            b->>'storage_bucket', b->>'storage_object_path', b->>'aqar_evidence_listing_id')
    ON CONFLICT (content_hash) DO NOTHING;
  END LOOP;

  -- (2) capture_class from the section manifest
  v_class := public._ingest_derive_class(p_manifest);

  -- (3) the snapshot, idempotent on its natural key
  INSERT INTO public.raw_snapshots (source, external_id, capture_class, adapter_id, adapter_version, manifest_hash, media_summary)
  VALUES (p_source, p_external_id, v_class, p_adapter_id, p_adapter_version, p_manifest_hash, coalesce(p_media_summary,'{}'::jsonb))
  ON CONFLICT (source, external_id, manifest_hash) DO NOTHING
  RETURNING id INTO v_snapshot_id;

  IF v_snapshot_id IS NOT NULL THEN
    v_was_new := true;
    -- (4) artifacts, in array order; remember ids by 1-based ordinality
    FOR r IN SELECT elem, ord FROM jsonb_array_elements(coalesce(p_artifacts,'[]'::jsonb))
                                    WITH ORDINALITY AS t(elem, ord) LOOP
      INSERT INTO public.raw_snapshot_artifacts (
        snapshot_id, artifact_type, media_type, source_url_or_endpoint, content_hash,
        retention_mode, retention_state, http_status, parser_hint, completeness,
        order_index, caption, width, height, duration_seconds, media_metadata)
      VALUES (
        v_snapshot_id, r.elem->>'artifact_type', r.elem->>'media_type', r.elem->>'source_url_or_endpoint', r.elem->>'content_hash',
        r.elem->>'retention_mode', r.elem->>'retention_state', (r.elem->>'http_status')::int, r.elem->>'parser_hint',
        coalesce(r.elem->>'completeness','complete'),
        (r.elem->>'order_index')::int, r.elem->>'caption', (r.elem->>'width')::int, (r.elem->>'height')::int,
        (r.elem->>'duration_seconds')::numeric, coalesce(r.elem->'media_metadata','{}'::jsonb))
      RETURNING id INTO v_aid;
      v_artifact_ids[r.ord] := v_aid;
    END LOOP;

    -- (5) section manifest, linking artifact_index (0-based) → artifact id
    FOR m IN SELECT value FROM jsonb_array_elements(coalesce(p_manifest,'[]'::jsonb)) LOOP
      INSERT INTO public.page_capture_manifest (snapshot_id, section, state, why_expected, artifact_id, note)
      VALUES (v_snapshot_id, m->>'section', m->>'state', m->>'why_expected',
              CASE WHEN m ? 'artifact_index' AND m->>'artifact_index' IS NOT NULL
                   THEN v_artifact_ids[(m->>'artifact_index')::int + 1] ELSE NULL END,
              m->>'note')
      ON CONFLICT (snapshot_id, section) DO NOTHING;
    END LOOP;
  ELSE
    SELECT id INTO v_snapshot_id FROM public.raw_snapshots
     WHERE source = p_source AND external_id = p_external_id AND manifest_hash = p_manifest_hash;
  END IF;

  -- (6) attach the snapshot to the run's item (advance only from pre-snapshot states)
  INSERT INTO public.ingestion_items (run_id, source, external_id, snapshot_id, state)
  VALUES (p_run_id, p_source, p_external_id, v_snapshot_id, 'raw_snapshot_saved')
  ON CONFLICT (run_id, source, external_id) DO UPDATE
    SET snapshot_id = EXCLUDED.snapshot_id,
        state = CASE WHEN public.ingestion_items.state IN ('discovered','fetched')
                     THEN 'raw_snapshot_saved' ELSE public.ingestion_items.state END;

  RETURN jsonb_build_object('snapshot_id', v_snapshot_id, 'was_new', v_was_new, 'capture_class', v_class);
END $$;
COMMENT ON FUNCTION public.ingest_capture_put(uuid,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb)
  IS 'Phase2: atomic idempotent capture writer (blobs+snapshot+artifacts+manifest); advances the item. service_role-only.';

-- ── 4. source_field_observe — discovery catalog upsert ───────────────────────
CREATE OR REPLACE FUNCTION public.source_field_observe(
  p_platform text, p_adapter_id text, p_contract_version text, p_source_path text,
  p_page_section text, p_source_label text, p_raw_data_type text, p_unit text, p_language text,
  p_example_values jsonb, p_example_snapshot_id uuid, p_example_listing_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.source_field_catalog (
    platform, adapter_id, contract_version, source_path, page_section, source_label,
    raw_data_type, unit, language, example_values, occurrence_count, example_snapshot_id, example_listing_id)
  VALUES (p_platform, p_adapter_id, p_contract_version, p_source_path, p_page_section, p_source_label,
          p_raw_data_type, p_unit, p_language,
          public._jsonb_bounded_union('[]'::jsonb, coalesce(p_example_values,'[]'::jsonb), 10),
          1, p_example_snapshot_id, p_example_listing_id)
  ON CONFLICT (platform, source_path, contract_version) DO UPDATE
    SET occurrence_count   = public.source_field_catalog.occurrence_count + 1,
        example_values     = public._jsonb_bounded_union(public.source_field_catalog.example_values, coalesce(EXCLUDED.example_values,'[]'::jsonb), 10),
        example_snapshot_id = coalesce(EXCLUDED.example_snapshot_id, public.source_field_catalog.example_snapshot_id),
        example_listing_id  = coalesce(EXCLUDED.example_listing_id,  public.source_field_catalog.example_listing_id),
        page_section = coalesce(EXCLUDED.page_section, public.source_field_catalog.page_section),
        source_label = coalesce(EXCLUDED.source_label, public.source_field_catalog.source_label),
        raw_data_type = coalesce(EXCLUDED.raw_data_type, public.source_field_catalog.raw_data_type),
        unit = coalesce(EXCLUDED.unit, public.source_field_catalog.unit),
        language = coalesce(EXCLUDED.language, public.source_field_catalog.language)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION public.source_field_observe(text,text,text,text,text,text,text,text,text,jsonb,uuid,uuid)
  IS 'Phase2: record/aggregate a discovered source field (no mapping decision). service_role-only.';

-- ── 5. schema_gap_raise — ONLY for captured-but-unmapped fields ──────────────
-- Never raises for a field carrying a terminal mapping decision. Optional-absent
-- fields are recorded on page_capture_manifest (not_present/not_applicable) by
-- the adapter and MUST NOT be routed here — conflating the two buries real gaps.
CREATE OR REPLACE FUNCTION public.schema_gap_raise(
  p_platform text, p_source_path text, p_contract_version text,
  p_suggested_type text, p_suggested_canonical_field text, p_criticality text,
  p_affected_record_delta bigint, p_sample_listing_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_map_status text; v_id uuid;
BEGIN
  SELECT status INTO v_map_status FROM public.source_field_mappings
    WHERE platform = p_platform AND source_path = p_source_path AND contract_version = p_contract_version;
  -- terminal decision ⇒ not a gap
  IF v_map_status IN ('mapped_existing_field','intentionally_ignored','technical_excluded','reviewed_source_specific') THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.schema_gap_events (
    platform, source_path, contract_version, occurrence_count, affected_record_count,
    sample_listing_ids, suggested_type, suggested_canonical_field, criticality, status)
  VALUES (p_platform, p_source_path, p_contract_version, 1, coalesce(p_affected_record_delta,0),
          CASE WHEN p_sample_listing_id IS NOT NULL THEN ARRAY[p_sample_listing_id] ELSE '{}'::uuid[] END,
          p_suggested_type, p_suggested_canonical_field, coalesce(p_criticality,'non_critical'), 'open')
  ON CONFLICT (platform, source_path, contract_version) DO UPDATE
    SET occurrence_count      = public.schema_gap_events.occurrence_count + 1,
        affected_record_count = public.schema_gap_events.affected_record_count + coalesce(EXCLUDED.affected_record_count,0),
        last_seen             = now(),
        sample_listing_ids    = public._uuid_bounded_union(public.schema_gap_events.sample_listing_ids, EXCLUDED.sample_listing_ids, 20),
        criticality           = CASE WHEN 'critical' IN (public.schema_gap_events.criticality, EXCLUDED.criticality)
                                      THEN 'critical' ELSE 'non_critical' END
        -- status left untouched: the review lifecycle owns it.
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;
COMMENT ON FUNCTION public.schema_gap_raise(text,text,text,text,text,text,bigint,uuid)
  IS 'Phase2: raise/aggregate a schema gap for a captured-but-unmapped field (no-op when a terminal mapping exists). service_role-only.';

-- ── 6. ingestion_run_finish ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ingestion_run_finish(p_run_id uuid, p_summary jsonb DEFAULT '{}'::jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.ingestion_runs
     SET ended_at = now(),
         summary  = coalesce(p_summary,'{}'::jsonb)
   WHERE id = p_run_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ingestion_run_finish: unknown run %', p_run_id; END IF;
END $$;
COMMENT ON FUNCTION public.ingestion_run_finish(uuid,jsonb) IS 'Phase2: close an ingestion run + store its summary. service_role-only.';

-- ── ACL lockdown (§12b): functions inherit EXECUTE to PUBLIC by default. ─────
-- Strip it everywhere and grant EXECUTE to service_role only (worker runtime).
-- Internal helpers are granted to no one (definer callers run as owner).
DO $lock$
DECLARE
  v_public_rpcs text[] := ARRAY[
    'public.ingestion_run_start(text,text)',
    'public.ingestion_item_set_state(uuid,text,text,text,text)',
    'public.ingest_capture_put(uuid,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb)',
    'public.source_field_observe(text,text,text,text,text,text,text,text,text,jsonb,uuid,uuid)',
    'public.schema_gap_raise(text,text,text,text,text,text,bigint,uuid)',
    'public.ingestion_run_finish(uuid,jsonb)'];
  v_helpers text[] := ARRAY[
    'public._ingest_derive_class(jsonb)',
    'public._jsonb_bounded_union(jsonb,jsonb,integer)',
    'public._uuid_bounded_union(uuid[],uuid[],integer)'];
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY v_public_rpcs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn); END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY v_helpers LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', v_fn); END IF;
  END LOOP;
END $lock$;

-- ── Assert the intended EXECUTE matrix (fail closed if a default leaked back) ─
DO $assert$
DECLARE
  v_public_rpcs text[] := ARRAY[
    'public.ingestion_run_start(text,text)',
    'public.ingestion_item_set_state(uuid,text,text,text,text)',
    'public.ingest_capture_put(uuid,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb)',
    'public.source_field_observe(text,text,text,text,text,text,text,text,text,jsonb,uuid,uuid)',
    'public.schema_gap_raise(text,text,text,text,text,text,bigint,uuid)',
    'public.ingestion_run_finish(uuid,jsonb)'];
  v_fn text; v_oid oid; v_bad text;
BEGIN
  FOREACH v_fn IN ARRAY v_public_rpcs LOOP
    v_oid := v_fn::regprocedure::oid;
    -- No non-service_role grantee may hold EXECUTE.
    SELECT string_agg(DISTINCT pg_get_userbyid(a.grantee), ',')
      INTO v_bad
      FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE'
       AND pg_get_userbyid(a.grantee) NOT IN ('postgres','service_role','supabase_admin');
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'ASSERT: % is EXECUTE-able by non-worker role(s): %', v_fn, v_bad;
    END IF;
    -- PUBLIC must not hold EXECUTE (grantee 0). proacl NULL would mean default (PUBLIC) — reject.
    IF (SELECT proacl IS NULL FROM pg_proc WHERE oid = v_oid) THEN
      RAISE EXCEPTION 'ASSERT: % still has default (PUBLIC) EXECUTE', v_fn;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'ASSERT: % grants EXECUTE to PUBLIC', v_fn;
    END IF;
  END LOOP;
END $assert$;

COMMIT;
