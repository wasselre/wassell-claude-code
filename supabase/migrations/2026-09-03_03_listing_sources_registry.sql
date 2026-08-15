-- ============================================================================
-- Phase 1 · 02 · listing_sources registry
-- ----------------------------------------------------------------------------
-- OWNER/PURPOSE: the single source of truth for which extraction platforms may
-- publish into public.market_listings. The canonical publisher (added in a later
-- migration, 08) rejects any source that is not present, active, and enabled here,
-- so a new platform is onboarded by INSERTing a row + shipping its adapter — never
-- by editing publisher SQL.
--
-- SAFETY: this migration creates ONE new table and seeds it. It does not touch
-- market_listings, records, grants on canonical tables, or any worker. Empty of
-- listing data. RLS enabled; app roles may read; writes are admin-only.
--
-- FORWARD RECOVERY: to disable a source, UPDATE is_active=false (publisher then
-- rejects it). To remove Phase-1 entirely, DROP TABLE public.listing_sources.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.listing_sources (
  source_key                text        PRIMARY KEY
                              CHECK (source_key ~ '^[a-z][a-z0-9_]{1,31}$'),
  display_name              text        NOT NULL,
  is_active                 boolean     NOT NULL DEFAULT false,
  publishing_enabled        boolean     NOT NULL DEFAULT false,
  adapter_id                text,
  adapter_version           text,
  allowed_evidence_stages   text[]      NOT NULL DEFAULT ARRAY['feed_partial','detail_complete','authoritative_api']::text[],
  validation_contract_version text      NOT NULL DEFAULT 'v1',
  health_status             text        NOT NULL DEFAULT 'unknown'
                              CHECK (health_status IN ('unknown','healthy','degraded','failing')),
  canary_status             text        NOT NULL DEFAULT 'none'
                              CHECK (canary_status IN ('none','pending','passed','failed')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.listing_sources IS 'Phase1: registry of extraction platforms; publisher gates on (is_active AND publishing_enabled). Admin-managed.';
COMMENT ON COLUMN public.listing_sources.allowed_evidence_stages IS 'Evidence tiers this adapter may claim; publisher rejects an unlisted stage.';

-- keep updated_at honest
CREATE OR REPLACE FUNCTION public.tg_listing_sources_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
COMMENT ON FUNCTION public.tg_listing_sources_touch() IS 'Phase1: maintains listing_sources.updated_at.';

DROP TRIGGER IF EXISTS trg_listing_sources_touch ON public.listing_sources;
CREATE TRIGGER trg_listing_sources_touch BEFORE UPDATE ON public.listing_sources
  FOR EACH ROW EXECUTE FUNCTION public.tg_listing_sources_touch();

-- Seed: Aqar is the only platform transitioned in Phase 1; UAE stay inactive
-- (present so the source dropdown + catalog can reference them) until their
-- adapters are built and approved in a later phase.
INSERT INTO public.listing_sources (source_key, display_name, is_active, publishing_enabled, adapter_id, adapter_version) VALUES
  ('aqar',           'Aqar (عقار)',       true,  false, 'market-ingest/adapters/aqar', 'v0'),
  ('bayut',          'Bayut (بيوت)',       false, false, NULL, NULL),
  ('dubizzle',       'Dubizzle (دوبيزل)',  false, false, NULL, NULL),
  ('propertyfinder', 'Property Finder',    false, false, NULL, NULL)
ON CONFLICT (source_key) DO NOTHING;
-- NB: publishing_enabled stays false for ALL sources in Phase 1. It is flipped to
-- true for 'aqar' only at Gate F/H, AFTER the publisher + lockdown are verified.

-- RLS: readable by authenticated app users + service_role; NO direct write policy
-- (mapping/registry changes go through an admin RPC added later; definer functions
-- bypass RLS as owner). This prevents silent direct writes.
ALTER TABLE public.listing_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_sources_read ON public.listing_sources;
-- least privilege: only admins read the extraction registry; sales users cannot.
CREATE POLICY listing_sources_read ON public.listing_sources
  FOR SELECT TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())));

REVOKE ALL ON public.listing_sources FROM PUBLIC, anon;
GRANT SELECT ON public.listing_sources TO authenticated, service_role;

COMMIT;
