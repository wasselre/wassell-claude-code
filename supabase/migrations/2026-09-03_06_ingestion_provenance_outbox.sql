-- ============================================================================
-- Phase 1 · 05 · Ingestion runs/items, change audit, field provenance, outbox
-- ----------------------------------------------------------------------------
-- OWNER/PURPOSE: the run/attempt ledger, the append-only canonical-change audit,
-- current field-level provenance, the transactional photo-mirror outbox, and the
-- quarantine review queue. Written only by the canonical publisher/edit core
-- (migration 08). This migration creates empty tables + immutability guards.
--
-- IDENTITIES: ingestion attempt = (run_id, source, external_id); canonical
-- identity = (source, external_id) on market_listings (unique idx in migration 09).
--
-- SAFETY: new tables only; no touch to canonical data/grants/workers.
-- FORWARD RECOVERY: change_events/provenance/review/outbox hold audit + queues,
-- never canonical listing bytes. Rollback NEVER drops change_events or provenance
-- once populated (see runbook); they may be retained even if Phase 1 is reverted.
-- ============================================================================

BEGIN;

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

-- Current field-level provenance (one row per listing; overwritten in place) ---
CREATE TABLE IF NOT EXISTS public.listing_field_provenance (
  record_id         uuid        PRIMARY KEY REFERENCES public.market_listings(id) ON DELETE CASCADE,
  field_provenance  jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_provenance) = 'object'),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.listing_field_provenance IS 'Phase1: current per-field provenance {field:{tier,snapshot_id,source_updated_at,adapter_version}}; O(listings) not O(changes).';

-- Transactional photo-mirror outbox ------------------------------------------
CREATE TABLE IF NOT EXISTS public.mirror_outbox (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id       uuid        NOT NULL REFERENCES public.market_listings(id) ON DELETE CASCADE,
  image_urls_hash text        NOT NULL CHECK (image_urls_hash ~ '^[a-f0-9]{64}$'),
  status          text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','done','failed')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (record_id, image_urls_hash)                       -- dedup: same image set enqueued once
);
COMMENT ON TABLE public.mirror_outbox IS 'Phase1: publisher writes a row (same tx) when image_urls change; a worker drains with dedup/retry/failure visibility. Not inline I/O.';
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON public.mirror_outbox (created_at) WHERE status IN ('pending','failed');

CREATE OR REPLACE FUNCTION public.tg_mirror_outbox_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_mirror_outbox_touch ON public.mirror_outbox;
CREATE TRIGGER trg_mirror_outbox_touch BEFORE UPDATE ON public.mirror_outbox
  FOR EACH ROW EXECUTE FUNCTION public.tg_mirror_outbox_touch();

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

-- RLS (least privilege): ingestion errors, historical before/after audit values,
-- and per-field provenance are internal operational data — ADMIN-ONLY read.
-- Ordinary authenticated sales users get zero rows; service_role (workers) bypasses
-- RLS. Only the definer publisher/edit/worker RPCs (later) write here.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ingestion_runs','ingestion_items','listing_change_events',
                           'listing_field_provenance','mirror_outbox','listing_change_review'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_read ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_read ON public.%1$I FOR SELECT TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())))', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
  END LOOP;
END $$;

COMMIT;
