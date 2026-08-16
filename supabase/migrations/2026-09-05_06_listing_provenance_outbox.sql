-- ============================================================================
-- Phase 1 · Gate A · 06 · Listing field provenance + transactional mirror outbox
-- IDEMPOTENT: safe to re-apply (verified by CI).
-- ----------------------------------------------------------------------------
-- OWNER/PURPOSE: the two market_listings-KEYED projections that were split out
-- of 2026-09-05_04_ingestion_audit.sql:
--   * listing_field_provenance — current per-field provenance, one row per
--     listing, overwritten in place. O(listings), not O(changes).
--   * mirror_outbox — the transactional photo-mirror queue. The publisher
--     writes a row in the SAME transaction as an image_urls change; a worker
--     drains it with dedup/retry/failure visibility. Never inline I/O.
--
-- WHY THIS IS A SEPARATE MIGRATION: both carry REAL foreign keys to
-- public.market_listings, which is created by the freeze baseline
-- (2026-09-03_02_market_listings_freeze_baseline.sql). The audit half of the
-- original PR #13 migration has no such dependency and landed earlier as _04.
--
-- THE FOREIGN KEYS ARE REQUIRED AND MUST NOT BE WEAKENED. They are what makes
-- provenance and queued mirror work disappear with the listing they describe.
-- Dropping them to make this migration land on a database without the frozen
-- table is expressly forbidden — apply the baseline instead.
--
-- SAFETY: two new tables only. No touch to market_listings itself, to records,
-- to any frozen policy, or to any worker. No listing data is read or written.
-- FORWARD RECOVERY: DROP both tables; they hold provenance + a queue, never
-- canonical listing bytes.
-- ============================================================================

BEGIN;

-- Fail-closed dependency preflight: a missing dependency must raise a NAMED,
-- actionable error here, never a raw FK/undefined-function error mid-migration.
DO $preflight$
BEGIN
  IF to_regclass('public.market_listings') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.market_listings is absent. listing_field_provenance and mirror_outbox carry REQUIRED foreign keys to it, which must not be weakened or omitted. It is created by supabase/migrations/2026-09-03_02_market_listings_freeze_baseline.sql (production already carries it from the ad-hoc 2026-08-06 freeze); apply the baseline first.';
  END IF;
  IF to_regprocedure('public.wassell_is_admin(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.wassell_is_admin(uuid) is absent. The admin-only RLS policies created by this migration call it. It is defined by the core access-control schema (supabase/schema.sql); apply the base schema before this migration.';
  END IF;
END $preflight$;

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
COMMENT ON FUNCTION public.tg_mirror_outbox_touch() IS 'Phase1: maintains mirror_outbox.updated_at.';

DROP TRIGGER IF EXISTS trg_mirror_outbox_touch ON public.mirror_outbox;
CREATE TRIGGER trg_mirror_outbox_touch BEFORE UPDATE ON public.mirror_outbox
  FOR EACH ROW EXECUTE FUNCTION public.tg_mirror_outbox_touch();

-- RLS (least privilege): per-field provenance and queued mirror work are
-- internal operational data — ADMIN-ONLY read. Ordinary authenticated sales
-- users get zero rows; service_role (workers) bypasses RLS. Only the definer
-- publisher/worker RPCs (a later Gate C/D migration) write here.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['listing_field_provenance','mirror_outbox'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_read ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_read ON public.%1$I FOR SELECT TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())))', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
  END LOOP;
END $$;

-- The foreign keys are the point of this migration: assert they survived.
DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class f ON f.oid = c.confrelid
     WHERE c.conrelid = 'public.listing_field_provenance'::regclass
       AND c.contype = 'f' AND f.relname = 'market_listings') THEN
    RAISE EXCEPTION 'ASSERT: listing_field_provenance lost its REQUIRED foreign key to market_listings';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class f ON f.oid = c.confrelid
     WHERE c.conrelid = 'public.mirror_outbox'::regclass
       AND c.contype = 'f' AND f.relname = 'market_listings') THEN
    RAISE EXCEPTION 'ASSERT: mirror_outbox lost its REQUIRED foreign key to market_listings';
  END IF;
END $assert$;

COMMIT;
