-- ============================================================================
-- Phase 1 · Gate A · 04 · Ingestion runs/items, change audit, quarantine review
-- IDEMPOTENT: safe to re-apply (verified by CI).
-- ----------------------------------------------------------------------------
-- OWNER/PURPOSE: the run/attempt ledger, the append-only canonical-change
-- audit, and the quarantine review queue. Written only by the canonical
-- publisher/edit core (added in a later Gate C/D migration). This migration
-- creates empty tables + immutability guards.
--
-- SPLIT (2026-08-16): this migration deliberately EXCLUDES listing_field_provenance
-- and mirror_outbox, which the PR #13 original bundled here. Both carry real FKs to
-- public.market_listings — a table that exists ONLY on production, created by an
-- out-of-repo ad-hoc freeze on 2026-08-06. The repository's supported bootstrap
-- (supabase/branch-bootstrap-*.sql, generated 2026-08-01) predates that freeze and
-- does not create it, so a migration FK-ing to it can never replay on any
-- repo-derived database.
--
-- A fail-closed preflight was considered and REJECTED: it converts an obscure FK
-- error into a clear one but still leaves the migration permanently un-replayable.
--
-- The two excluded tables, their FKs, indexes, trigger, function and RLS move to
-- 2026-09-05_06_listing_provenance_outbox.sql, which runs AFTER the deferred
-- 2026-09-05_05_market_listings_freeze_baseline.sql. Their foreign keys must NOT be
-- weakened or omitted when _06 is authored. The four tables kept here have no
-- market_listings dependency: listing_change_events.record_id and
-- listing_change_review.record_id deliberately carry no FK in the original design.
-- See docs/market-ingest/gate-a.md.
--
-- IDENTITIES: ingestion attempt = (run_id, source, external_id); canonical
-- identity = (source, external_id) on market_listings (unique idx added in a
-- later Gate C/D migration).
--
-- SAFETY: new tables only; no touch to canonical data/grants/workers.
-- FORWARD RECOVERY: change_events/review hold audit + queues, never canonical
-- listing bytes. Rollback NEVER drops change_events or review once populated
-- (see runbook); they may be retained even if Phase 1 is reverted.
-- ============================================================================

BEGIN;

-- Fail-closed dependency preflight: a missing dependency must raise a NAMED,
-- actionable error here, never a raw FK/undefined-function error mid-migration.
DO $preflight$
BEGIN
  IF to_regclass('public.listing_sources') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.listing_sources is absent. ingestion_runs.source and ingestion_items.source carry real FKs to it. Apply 2026-09-05_01_listing_sources_registry.sql first.';
  END IF;
  IF to_regclass('public.raw_snapshots') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.raw_snapshots is absent. ingestion_items.snapshot_id, listing_change_events.raw_snapshot_id and listing_change_review.snapshot_id carry real FKs to it. Apply 2026-09-05_02_raw_capture.sql first.';
  END IF;
  IF to_regclass('public.raw_blobs') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.raw_blobs is absent. ingestion_items.content_hash carries a real FK to it. Apply 2026-09-05_02_raw_capture.sql first.';
  END IF;
  IF to_regprocedure('public.wassell_is_admin(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.wassell_is_admin(uuid) is absent. The admin-only RLS policies created by this migration call it. It is defined by the core access-control schema (supabase/schema.sql); apply the base schema before this migration.';
  END IF;
  IF to_regprocedure('public._ml_reject_mutation()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public._ml_reject_mutation() is absent. The append-only trigger trg_change_events_immutable created by this migration binds to it. It is defined by 2026-09-05_02_raw_capture.sql; apply that migration first.';
  END IF;
END $preflight$;

-- Ingestion run + per-attempt item -------------------------------------------
CREATE TABLE IF NOT EXISTS public.ingestion_runs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source           text        NOT NULL REFERENCES public.listing_sources(source_key) ON DELETE RESTRICT,
  adapter_version  text        NOT NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  summary          jsonb       NOT NULL DEFAULT '{}'::jsonb
                     CHECK (jsonb_typeof(summary) = 'object')
);
COMMENT ON TABLE public.ingestion_runs IS 'Phase1: one extraction run; summary holds the schema-gap/capture report (see runbook contract).';

CREATE TABLE IF NOT EXISTS public.ingestion_items (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid        NOT NULL REFERENCES public.ingestion_runs(id) ON DELETE CASCADE,
  source       text        NOT NULL REFERENCES public.listing_sources(source_key) ON DELETE RESTRICT,
  external_id  text        NOT NULL CHECK (btrim(external_id) <> ''),
  snapshot_id  uuid        REFERENCES public.raw_snapshots(id) ON DELETE RESTRICT,
  content_hash text        REFERENCES public.raw_blobs(content_hash) ON DELETE RESTRICT,
  state        text        NOT NULL DEFAULT 'discovered'
                 CHECK (state IN ('discovered','fetched','raw_snapshot_saved','parsed','normalized',
                                  'validated','enriched','ready_to_publish','published',
                                  'published_with_schema_gaps','fetch_failed','parse_failed',
                                  'validation_failed','enrichment_failed','quarantined','noop')),
  error        text,
  fetched_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, source, external_id)
);
COMMENT ON TABLE public.ingestion_items IS 'Phase1: one attempt per listing per run; the lifecycle state machine. The same unchanged payload on two dates = two items (distinct run).';

CREATE INDEX IF NOT EXISTS ix_items_run    ON public.ingestion_items (run_id);
CREATE INDEX IF NOT EXISTS ix_items_listing ON public.ingestion_items (source, external_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_items_state  ON public.ingestion_items (state)
  WHERE state IN ('quarantined','fetch_failed','parse_failed','validation_failed','enrichment_failed');

-- Append-only canonical-change audit -----------------------------------------
-- record_id has NO FK: the audit MUST survive a listing deletion.
CREATE TABLE IF NOT EXISTS public.listing_change_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id       uuid        NOT NULL,
  source          text        NOT NULL,
  external_id     text        NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  actor           text,                                    -- auth.uid() for manual, 'system:<adapter>' for publish
  kind            text        NOT NULL CHECK (kind IN ('system_publish','manual_edit','set_split','canary_rollback')),
  reason          text,
  adapter_version text,
  raw_snapshot_id uuid        REFERENCES public.raw_snapshots(id) ON DELETE RESTRICT,
  diff            jsonb       NOT NULL CHECK (jsonb_typeof(diff) = 'object')
);
COMMENT ON TABLE public.listing_change_events IS 'Phase1: APPEND-ONLY audit; one row per publish/edit; diff = {field:{before,after,tier,decision}}. Survives listing deletion.';
CREATE INDEX IF NOT EXISTS ix_change_events_record ON public.listing_change_events (record_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_change_events_listing ON public.listing_change_events (source, external_id, at DESC);

-- Quarantine / suspicious-change review queue --------------------------------
-- record_id NO FK: a quarantined change may reference a listing that does not
-- yet exist (insert-time critical gap) and must survive deletion.
CREATE TABLE IF NOT EXISTS public.listing_change_review (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id    uuid,
  source       text        NOT NULL,
  external_id  text        NOT NULL,
  field        text        NOT NULL,
  before_value jsonb,
  after_value  jsonb,
  reason       text        NOT NULL,
  criticality  text        NOT NULL DEFAULT 'non_critical' CHECK (criticality IN ('critical','non_critical')),
  snapshot_id  uuid        REFERENCES public.raw_snapshots(id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved     boolean     NOT NULL DEFAULT false,
  resolved_by  text,
  resolved_at  timestamptz
);
COMMENT ON TABLE public.listing_change_review IS 'Phase1: suspicious/critical changes held for human review instead of being applied.';
CREATE INDEX IF NOT EXISTS ix_review_open ON public.listing_change_review (created_at) WHERE resolved = false;

-- Append-only enforcement for the audit table.
DROP TRIGGER IF EXISTS trg_change_events_immutable ON public.listing_change_events;
CREATE TRIGGER trg_change_events_immutable BEFORE UPDATE OR DELETE ON public.listing_change_events
  FOR EACH ROW EXECUTE FUNCTION public._ml_reject_mutation();

-- RLS (least privilege): ingestion errors and historical before/after audit
-- values are internal operational data — ADMIN-ONLY read. Ordinary
-- authenticated sales users get zero rows; service_role (workers) bypasses
-- RLS. Only the definer publisher/edit/worker RPCs (later) write here.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ingestion_runs','ingestion_items','listing_change_events','listing_change_review'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_read ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_read ON public.%1$I FOR SELECT TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())))', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
  END LOOP;
END $$;

COMMIT;
