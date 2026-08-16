-- ============================================================================
-- Phase 1 · Gate A · 02 · Multi-artifact immutable raw capture
-- IDEMPOTENT: safe to re-apply (verified by CI).
-- ----------------------------------------------------------------------------
-- OWNER/PURPOSE: lossless, immutable, content-addressed evidence for every
-- listing capture. A snapshot is ONE logical listing capture composed of MANY
-- artifacts (detail HTML, embedded JSON, JSON-LD, detail/permit APIs, images,
-- videos, floor plans, virtual tours, documents). The page_capture_manifest
-- records, per expected section, WHY it was expected and WHICH of the 7 capture
-- states it reached. capture_class is derived from that manifest.
--
-- IMMUTABILITY: raw_blobs / raw_snapshots / raw_snapshot_artifacts /
-- page_capture_manifest are APPEND-ONLY. A trigger rejects UPDATE/DELETE and no
-- role is granted UPDATE/DELETE. This is the "raw truth" layer; nothing may edit
-- it. Replay resolves the exact bytes by content_hash.
--
-- SAFETY: new tables only; no touch to market_listings/records/grants/workers.
-- FORWARD RECOVERY: DROP the four tables (empty) to remove; they never mutate
-- canonical data, so removal is data-safe.
-- ============================================================================

BEGIN;

-- Fail-closed dependency preflight: a missing dependency must raise a NAMED,
-- actionable error here, never a raw FK/undefined-function error mid-migration.
DO $preflight$
BEGIN
  IF to_regclass('public.listing_sources') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.listing_sources is absent. raw_snapshots.source carries a real FK to it. Apply 2026-09-05_01_listing_sources_registry.sql first.';
  END IF;
  IF to_regclass('public.aqar_listing_evidence') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.aqar_listing_evidence is absent. raw_blobs.aqar_evidence_listing_id carries a real FK to it. It is created by supabase/migrations/2026-07-29_aqar_listing_extract_lane.sql; apply that migration first.';
  END IF;
  IF to_regprocedure('public.wassell_is_admin(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.wassell_is_admin(uuid) is absent. The admin-only RLS policies created by this migration call it. It is defined by the core access-control schema (supabase/schema.sql); apply the base schema before this migration.';
  END IF;
END $preflight$;

-- Shared immutability guard ---------------------------------------------------
CREATE OR REPLACE FUNCTION public._ml_reject_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %.%: % is not permitted (raw evidence is immutable)',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$;
COMMENT ON FUNCTION public._ml_reject_mutation() IS 'Phase1: enforces append-only on raw-evidence tables (rejects UPDATE/DELETE).';

-- raw_blobs: immutable, content-addressed bytes. Exactly ONE storage location:
--   * storage_object_path  -> an object in a Wassell Storage bucket (incl. the
--                             existing listing-photos mirror; link, do NOT copy).
--   * aqar_evidence_listing_id -> the DB-backed Aqar evidence bundle (real FK).
-- The CHECK guarantees exactly one; no free-text discriminator.
CREATE TABLE IF NOT EXISTS public.raw_blobs (
  content_hash              text        PRIMARY KEY
                              CHECK (content_hash ~ '^[a-f0-9]{64}$'),        -- sha256 hex
  media_type                text        NOT NULL,                             -- MIME
  size_bytes                bigint      NOT NULL CHECK (size_bytes >= 0),
  storage_bucket            text,
  storage_object_path       text,
  aqar_evidence_listing_id  text        REFERENCES public.aqar_listing_evidence(listing_id) ON DELETE RESTRICT,
  first_seen                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT raw_blobs_exactly_one_location CHECK (
    (storage_object_path IS NOT NULL)::int + (aqar_evidence_listing_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT raw_blobs_bucket_with_path CHECK (
    (storage_object_path IS NULL) = (storage_bucket IS NULL)
  )
);
COMMENT ON TABLE public.raw_blobs IS 'Phase1: immutable content-addressed evidence bytes; deduped by sha256. Exactly one storage location (Storage object OR aqar evidence row).';

-- raw_snapshots: one logical capture of one listing at one moment.
CREATE TABLE IF NOT EXISTS public.raw_snapshots (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source                    text        NOT NULL REFERENCES public.listing_sources(source_key) ON DELETE RESTRICT,
  external_id               text        NOT NULL CHECK (btrim(external_id) <> ''),
  captured_at               timestamptz NOT NULL DEFAULT now(),
  capture_class             text        NOT NULL
                              CHECK (capture_class IN ('complete','partial','blocked','failed')),
  adapter_id                text        NOT NULL,
  adapter_version           text        NOT NULL,
  manifest_hash             text        NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  -- source-reported vs captured media counts are BOTH retained here (never conflated):
  media_summary             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT raw_snapshots_media_summary_obj CHECK (jsonb_typeof(media_summary) = 'object'),
  UNIQUE (source, external_id, manifest_hash)
);
COMMENT ON TABLE  public.raw_snapshots IS 'Phase1: one immutable listing capture; capture_class derived from page_capture_manifest.';
COMMENT ON COLUMN public.raw_snapshots.media_summary IS 'Both source-reported and captured media counts, e.g. {"images":{"source_count":15,"captured_count":15},"videos":{"source_count":1,"captured_count":1}}.';

-- raw_snapshot_artifacts: every artifact captured for a snapshot + its durable
-- retention policy + full media metadata (retained even when the asset lives
-- elsewhere, e.g. listing-photos).
CREATE TABLE IF NOT EXISTS public.raw_snapshot_artifacts (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id               uuid        NOT NULL REFERENCES public.raw_snapshots(id) ON DELETE RESTRICT,
  artifact_type             text        NOT NULL,          -- detail_html|next_data|jsonld|hydration_state|detail_api|permit_api|image|video|floor_plan|virtual_tour|document|media_manifest|...
  media_type                text,                          -- MIME when applicable
  source_url_or_endpoint    text,
  content_hash              text        REFERENCES public.raw_blobs(content_hash) ON DELETE RESTRICT,  -- NULL only for source_url_metadata_only
  -- TWO INDEPENDENT AXES (do not conflate with capture):
  --  * retention_mode  = the MECHANISM used to retain the asset.
  --  * retention_state = the durability OUTCOME (whether Wassell durably holds it).
  -- capture completeness lives separately on page_capture_manifest.state.
  retention_mode            text        NOT NULL
                              CHECK (retention_mode IN ('original_bytes','immutable_mirror','manifest_and_segments','source_url_metadata_only','existing_storage_ref')),
  retention_state           text        NOT NULL
                              CHECK (retention_state IN ('durable_original','durable_existing_asset','external_reference_only','retention_failed','not_applicable')),
  CONSTRAINT retention_mode_state_consistent CHECK (
    (retention_mode = 'existing_storage_ref'      AND retention_state IN ('durable_existing_asset','retention_failed')) OR
    (retention_mode = 'source_url_metadata_only'  AND retention_state IN ('external_reference_only','not_applicable'))  OR
    (retention_mode IN ('original_bytes','immutable_mirror','manifest_and_segments') AND retention_state IN ('durable_original','retention_failed'))
  ),
  http_status               integer,
  parser_hint               text,
  completeness              text        NOT NULL DEFAULT 'complete'
                              CHECK (completeness IN ('complete','partial','unknown')),
  order_index               integer,                       -- media gallery order preserved
  caption                   text,
  width                     integer,
  height                    integer,
  duration_seconds          numeric,
  media_metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  captured_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT artifact_bytes_present_unless_url_only CHECK (
    retention_mode = 'source_url_metadata_only' OR content_hash IS NOT NULL
  )
);
COMMENT ON TABLE  public.raw_snapshot_artifacts IS 'Phase1: every artifact of a snapshot; retention_mode states how bytes are kept; media metadata retained even when bytes live in an existing bucket.';
COMMENT ON COLUMN public.raw_snapshot_artifacts.retention_mode IS 'original_bytes=stored here; immutable_mirror=copied to our bucket; manifest_and_segments=HLS/DASH stored; source_url_metadata_only=URL+metadata only (no bytes); existing_storage_ref=links an already-mirrored object (e.g. listing-photos).';

-- page_capture_manifest: per-expected-section capture state + WHY expected.
CREATE TABLE IF NOT EXISTS public.page_capture_manifest (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id               uuid        NOT NULL REFERENCES public.raw_snapshots(id) ON DELETE RESTRICT,
  section                   text        NOT NULL,          -- e.g. images | videos | rega_license_link | floor_plans | detail_api | features
  state                     text        NOT NULL
                              CHECK (state IN ('captured','not_present','not_applicable','missing_expected','blocked','failed','unknown')),
  why_expected              text        NOT NULL,          -- source_reported_count | tab | button | embedded_identifier | api_reference | platform_contract | none
  artifact_id               uuid        REFERENCES public.raw_snapshot_artifacts(id) ON DELETE RESTRICT,
  note                      text,
  UNIQUE (snapshot_id, section)
);
COMMENT ON TABLE  public.page_capture_manifest IS 'Phase1: per-section capture state. complete iff no section is missing_expected/blocked/failed/unknown; a section that is not_present/not_applicable does NOT reduce completeness and is NOT a schema gap.';
COMMENT ON COLUMN public.page_capture_manifest.why_expected IS 'Evidence the section should exist: source_reported_count|tab|button|embedded_identifier|api_reference|platform_contract|none.';

-- Derivation helper (pure): capture_class from a manifest, for review/verification.
CREATE OR REPLACE FUNCTION public.raw_snapshot_derive_class(p_snapshot_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN bool_or(state = 'blocked') THEN 'blocked'
    WHEN bool_or(state = 'failed')  THEN 'failed'
    WHEN bool_or(state IN ('missing_expected','unknown')) THEN 'partial'
    ELSE 'complete'
  END
  FROM public.page_capture_manifest WHERE snapshot_id = p_snapshot_id;
$$;
COMMENT ON FUNCTION public.raw_snapshot_derive_class(uuid) IS 'Phase1: derives capture_class from the section manifest (verification helper; publisher recomputes and stores on the snapshot at insert).';

-- Indexes: replay lookup + review of incomplete captures.
CREATE INDEX IF NOT EXISTS ix_raw_snapshots_listing     ON public.raw_snapshots (source, external_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS ix_raw_snapshots_class        ON public.raw_snapshots (capture_class) WHERE capture_class <> 'complete';
CREATE INDEX IF NOT EXISTS ix_artifacts_snapshot         ON public.raw_snapshot_artifacts (snapshot_id);
CREATE INDEX IF NOT EXISTS ix_artifacts_blob             ON public.raw_snapshot_artifacts (content_hash);
CREATE INDEX IF NOT EXISTS ix_manifest_snapshot          ON public.page_capture_manifest (snapshot_id);
CREATE INDEX IF NOT EXISTS ix_manifest_incomplete        ON public.page_capture_manifest (state)
  WHERE state IN ('missing_expected','blocked','failed','unknown');

-- Append-only enforcement.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['raw_blobs','raw_snapshots','raw_snapshot_artifacts','page_capture_manifest'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_immutable ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_immutable BEFORE UPDATE OR DELETE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public._ml_reject_mutation()', t);
  END LOOP;
END $$;

-- RLS (least privilege): raw evidence contains phone numbers, full source payloads,
-- regulatory data and media URLs — ADMIN-ONLY read. Ordinary authenticated sales
-- users get zero rows. service_role (workers) bypasses RLS. Inserts happen only via
-- the definer publisher/adapter RPCs (added in a later Gate C/D migration,
-- owner-run). No UPDATE/DELETE grants anywhere (also blocked by the append-only
-- trigger).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['raw_blobs','raw_snapshots','raw_snapshot_artifacts','page_capture_manifest'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_read ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_read ON public.%1$I FOR SELECT TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())))', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- STORAGE ENFORCEMENT IS DEFERRED TO GATE B — deliberately absent here.
--
-- The `market-raw` private bucket, the NOLOGIN/NOBYPASSRLS `market_raw_uploader`
-- role, and the INSERT-only `storage.objects` policies are NOT created by this
-- migration. They depend on an UNPROVEN assumption: that the deployed Supabase
-- Storage version honours a custom `role` JWT claim for a non-service_role
-- uploader. Shipping the DDL before that is proven would create a bucket whose
-- advertised immutability guarantee is unverified — worse than no bucket.
--
-- Until Gate B lands: raw_blobs.storage_bucket / storage_object_path remain
-- plain text columns recording WHERE bytes live. Nothing in this migration
-- writes them, and no code path depends on the bucket existing.
--
-- Gate B must verify custom-role JWT support and, if unsupported, ship the
-- INSERT-only edge-signer fallback instead. See docs/market-ingest/gate-a.md.
-- ---------------------------------------------------------------------------

COMMIT;
