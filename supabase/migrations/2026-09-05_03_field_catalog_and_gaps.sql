-- ============================================================================
-- Phase 1 · Gate A · 03 · Source-field catalog, authoritative mappings, schema-gap events
-- IDEMPOTENT: safe to re-apply (verified by CI).
-- ----------------------------------------------------------------------------
-- OWNER/PURPOSE: govern every listing-related datum a platform exposes.
--   * source_field_catalog  — DISCOVERY: what fields exist, examples, frequency.
--                             Mutable (counts/last_seen updated per extraction).
--                             Holds NO decision (prevents status drift).
--   * source_field_mappings — the SINGLE AUTHORITATIVE decision per field, per
--                             contract version. History preserved (old versions
--                             retained; latest version = active).
--   * schema_gap_events     — the REVIEW LIFECYCLE for unmapped/uncertain fields.
--                             Its status may not claim "resolved" without an
--                             authoritative mapping decision (enforced).
-- A view reconciles the three so catalog/mapping/gap statuses cannot contradict.
--
-- SAFETY: new tables only; no touch to canonical data/grants/workers.
-- FORWARD RECOVERY: DROP the view + three tables (they carry governance metadata,
-- never canonical listing bytes; raw evidence is untouched).
-- ============================================================================

BEGIN;

-- Fail-closed dependency preflight: a missing dependency must raise a NAMED,
-- actionable error here, never a raw FK/undefined-function error mid-migration.
DO $preflight$
BEGIN
  IF to_regclass('public.listing_sources') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.listing_sources is absent. source_field_catalog.platform, source_field_mappings.platform and schema_gap_events.platform carry real FKs to it. Apply 2026-09-05_01_listing_sources_registry.sql first.';
  END IF;
  IF to_regclass('public.raw_snapshots') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.raw_snapshots is absent. source_field_catalog.example_snapshot_id carries a real FK to it. Apply 2026-09-05_02_raw_capture.sql first.';
  END IF;
  IF to_regprocedure('public.wassell_is_admin(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.wassell_is_admin(uuid) is absent. The admin-only RLS policies created by this migration call it. It is defined by the core access-control schema (supabase/schema.sql); apply the base schema before this migration.';
  END IF;
END $preflight$;

-- Discovery catalog (mutable metadata; NO decision column) --------------------
CREATE TABLE IF NOT EXISTS public.source_field_catalog (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform            text        NOT NULL REFERENCES public.listing_sources(source_key) ON DELETE RESTRICT,
  adapter_id          text        NOT NULL,
  contract_version    text        NOT NULL,
  source_path         text        NOT NULL,                 -- stable path, e.g. property.floor_plans[]
  page_section        text,                                 -- detail.property.media, permit_api, ...
  source_label        text,                                 -- human-facing label as shown on the page
  raw_data_type       text,                                 -- string|number|bool|array|object|url|date
  unit                text,
  language            text,                                 -- ar|en|mixed|na
  example_values      jsonb       NOT NULL DEFAULT '[]'::jsonb
                        CHECK (jsonb_typeof(example_values) = 'array'
                               AND jsonb_array_length(example_values) <= 10),  -- bounded
  first_seen          timestamptz NOT NULL DEFAULT now(),
  last_seen           timestamptz NOT NULL DEFAULT now(),
  occurrence_count    bigint      NOT NULL DEFAULT 0 CHECK (occurrence_count >= 0),
  example_snapshot_id uuid        REFERENCES public.raw_snapshots(id) ON DELETE SET NULL,
  example_listing_id  uuid,                                 -- market_listings.id (no FK: cross-lifecycle)
  UNIQUE (platform, source_path, contract_version)
);
COMMENT ON TABLE public.source_field_catalog IS 'Phase1: discovery inventory of every source field; mutable counts/examples; holds NO mapping decision (see source_field_mappings).';

-- Authoritative decision (versioned; history preserved) -----------------------
CREATE TABLE IF NOT EXISTS public.source_field_mappings (
  platform                 text        NOT NULL REFERENCES public.listing_sources(source_key) ON DELETE RESTRICT,
  source_path              text        NOT NULL,
  contract_version         text        NOT NULL,
  status                   text        NOT NULL
                             CHECK (status IN ('mapped_existing_field','candidate_new_field','review_required',
                                               'reviewed_source_specific','intentionally_ignored','technical_excluded','unresolved')),
  canonical_field          text,                            -- set iff status='mapped_existing_field'
  transformation           text,
  is_equivalent_to_existing boolean,
  reviewer                 text,                            -- required for ignored/excluded/source_specific
  reason                   text,
  decided_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, source_path, contract_version),
  CONSTRAINT mapping_field_iff_mapped CHECK (
    (status = 'mapped_existing_field') = (canonical_field IS NOT NULL)
  ),
  CONSTRAINT mapping_reason_required CHECK (
    status NOT IN ('intentionally_ignored','technical_excluded','reviewed_source_specific')
    OR (reviewer IS NOT NULL AND reason IS NOT NULL AND decided_at IS NOT NULL)
  )
);
COMMENT ON TABLE public.source_field_mappings IS 'Phase1: THE authoritative mapping decision per source field per contract version. Latest contract_version = active; older rows retained as history.';

-- Schema-gap review lifecycle -------------------------------------------------
CREATE TABLE IF NOT EXISTS public.schema_gap_events (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  platform               text        NOT NULL REFERENCES public.listing_sources(source_key) ON DELETE RESTRICT,
  source_path            text        NOT NULL,
  contract_version       text        NOT NULL,
  first_seen             timestamptz NOT NULL DEFAULT now(),
  last_seen              timestamptz NOT NULL DEFAULT now(),
  occurrence_count       bigint      NOT NULL DEFAULT 1 CHECK (occurrence_count >= 0),
  affected_record_count  bigint      NOT NULL DEFAULT 0 CHECK (affected_record_count >= 0),
  affected_platforms     text[]      NOT NULL DEFAULT '{}',
  sample_listing_ids     uuid[]      NOT NULL DEFAULT '{}'
                           CHECK (array_length(sample_listing_ids,1) IS NULL OR array_length(sample_listing_ids,1) <= 20),  -- bounded sample; counts stay accurate above
  suggested_type         text,
  suggested_canonical_field text,
  suggested_relationship text,
  appears_equivalent_to  text,
  replayable             boolean     NOT NULL DEFAULT true,
  criticality            text        NOT NULL DEFAULT 'non_critical'
                           CHECK (criticality IN ('critical','non_critical')),
  status                 text        NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','notified','in_review','resolved','wont_map')),
  notified_at            timestamptz,
  resolved_at            timestamptz,
  UNIQUE (platform, source_path, contract_version)
);
COMMENT ON TABLE public.schema_gap_events IS 'Phase1: aggregated review lifecycle per unmapped/uncertain field. Cannot be resolved without an authoritative mapping decision (enforced by trigger).';
COMMENT ON COLUMN public.schema_gap_events.sample_listing_ids IS 'Bounded representative sample (<=20); occurrence_count and affected_record_count remain exact.';

-- Anti-drift enforcement: a gap may only be resolved/wont_map when the active
-- mapping has a terminal decision. This keeps gap status from contradicting the
-- authoritative mapping.
CREATE OR REPLACE FUNCTION public.tg_schema_gap_requires_decision()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE v_status text;
BEGIN
  IF NEW.status IN ('resolved','wont_map') THEN
    SELECT status INTO v_status FROM public.source_field_mappings
      WHERE platform = NEW.platform AND source_path = NEW.source_path AND contract_version = NEW.contract_version;
    IF v_status IS NULL OR v_status IN ('review_required','unresolved') THEN
      RAISE EXCEPTION 'schema_gap_events(%, %) cannot be %: no terminal source_field_mappings decision exists',
        NEW.platform, NEW.source_path, NEW.status USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION public.tg_schema_gap_requires_decision() IS 'Phase1: prevents a schema gap being closed without an authoritative mapping decision.';

DROP TRIGGER IF EXISTS trg_schema_gap_requires_decision ON public.schema_gap_events;
CREATE TRIGGER trg_schema_gap_requires_decision BEFORE INSERT OR UPDATE ON public.schema_gap_events
  FOR EACH ROW EXECUTE FUNCTION public.tg_schema_gap_requires_decision();

-- Reconciled status view: the ONE place to read a field's governance state.
-- Authoritative status = latest source_field_mappings row; catalog + gap join in.
-- CONSTRAINT ON contract_version: "latest" is resolved by DESCENDING TEXT sort,
-- which is LEXICAL, not numeric — 'v9' sorts after 'v10'. Contract versions must
-- therefore be lexically sortable (zero-pad: 'v001', 'v002', ... 'v010').
-- This is a naming contract, deliberately not enforced by a CHECK, because the
-- correct padding width is a Phase-3 adapter decision. Documented in
-- docs/market-ingest/gate-a.md.
CREATE OR REPLACE VIEW public.v_source_field_status AS
WITH active_map AS (
  SELECT DISTINCT ON (platform, source_path) platform, source_path, contract_version, status, canonical_field, reviewer, reason, decided_at
  FROM public.source_field_mappings
  ORDER BY platform, source_path, contract_version DESC
)
SELECT
  c.platform, c.source_path, c.source_label, c.page_section, c.raw_data_type, c.language,
  c.occurrence_count, c.last_seen, c.example_values,
  COALESCE(m.status, 'unresolved')       AS authoritative_status,
  m.canonical_field, m.reviewer, m.reason, m.decided_at,
  g.status                               AS gap_status,
  g.criticality, g.affected_record_count, g.replayable
FROM public.source_field_catalog c
LEFT JOIN active_map m USING (platform, source_path)
LEFT JOIN public.schema_gap_events g
  ON g.platform = c.platform AND g.source_path = c.source_path AND g.contract_version = c.contract_version;
-- security_invoker so the caller's admin-gated RLS on the base tables applies
-- (a non-admin must NOT see governance data through the view).
ALTER VIEW public.v_source_field_status SET (security_invoker = true);
COMMENT ON VIEW public.v_source_field_status IS 'Phase1: single reconciled governance status per source field (authoritative = latest mapping). security_invoker=true.';

-- keep catalog.last_seen honest on upsert (occurrence_count maintained by writer)
CREATE OR REPLACE FUNCTION public.tg_source_field_catalog_touch()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN NEW.last_seen := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS trg_source_field_catalog_touch ON public.source_field_catalog;
CREATE TRIGGER trg_source_field_catalog_touch BEFORE UPDATE ON public.source_field_catalog
  FOR EACH ROW EXECUTE FUNCTION public.tg_source_field_catalog_touch();

-- Indexes for review + aggregation.
CREATE INDEX IF NOT EXISTS ix_catalog_platform        ON public.source_field_catalog (platform, source_path);
CREATE INDEX IF NOT EXISTS ix_gap_open                ON public.schema_gap_events (status) WHERE status IN ('open','notified','in_review');
CREATE INDEX IF NOT EXISTS ix_gap_critical            ON public.schema_gap_events (criticality) WHERE criticality = 'critical';
CREATE INDEX IF NOT EXISTS ix_mappings_active         ON public.source_field_mappings (platform, source_path, contract_version DESC);

-- RLS (least privilege): schema-gap samples reference real listings + example
-- values (may include advertiser/regulatory data) — ADMIN-ONLY read (admins act as
-- schema reviewers in Phase 1; a dedicated reviewer capability can be added later).
-- Governance edits go through an admin RPC (later); definer functions bypass RLS.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['source_field_catalog','source_field_mappings','schema_gap_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_read ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_read ON public.%1$I FOR SELECT TO authenticated USING (public.wassell_is_admin((SELECT auth.uid())))', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
  END LOOP;
END $$;
-- The reconciled-status view runs with security_invoker = true (set above), so
-- the CALLER's admin-gated RLS on the base tables applies: a non-admin reading
-- the view sees zero rows. anon is revoked outright; authenticated and
-- service_role keep SELECT, with admins the effective readers via the
-- underlying base-table policies.
REVOKE ALL ON public.v_source_field_status FROM PUBLIC, anon;
GRANT SELECT ON public.v_source_field_status TO authenticated, service_role;

COMMIT;
