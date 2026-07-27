-- ============================================================================
-- OUR_PROJECTS collection scope (2026-08-18).
--
-- The authoritative scope for project-marketing collection is MEMBERSHIP IN THE
-- our_projects module, whose `project` field is a lookup into all_projects.
-- Scope is NOT inferred from "projects that already have content", the
-- marketing rollup, or which organizations happen to have accounts configured —
-- every one of those is a consequence of past collection, not a definition of
-- what should be collected.
--
-- The research table exists because the audit found 185 organizations in an
-- indeterminate state: a missing row was being read as "no account exists" when
-- it actually meant "nobody ever looked". A missing row must never carry
-- meaning; the state column carries it.
--
-- This file previously contained only a comment pointing at Supabase for the
-- real statements — which meant replaying the repo would NOT create these
-- objects. Exported verbatim from schema_migrations so repo and database match.
-- ============================================================================

-- ── applied as 20260727102451 — "mkt_our_projects_scope" ──────────────────────────────
-- ============================================================================
-- OUR_PROJECTS collection scope (2026-08-18).
--
-- The authoritative scope for all project-marketing collection is MEMBERSHIP IN
-- THE our_projects MODULE — not "projects that already have content", not the
-- marketing rollup, not organizations that happen to have accounts configured.
-- A project is in scope IFF an our_projects record currently points at it.
--
-- Additive only: one view + two tables. Nothing existing is altered.
-- ============================================================================

-- ── Authoritative scope view ────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_our_projects_scope AS
SELECT
  op.id                                   AS our_project_id,
  ap.id                                   AS project_id,
  ap.data->>'project_name'                AS project_name_ar,
  ap.data->>'project_name_en'             AS project_name_en,
  NULLIF(ap.data->>'developer','')::uuid  AS developer_record_id,
  dev.data->>'developer_name'             AS developer_name,
  ap.data->>'city_name'                   AS city,
  ap.data->>'project_location'            AS location_text,
  ap.data->>'project_page_url'            AS project_page_url,
  ap.data->>'brochure_link'               AS brochure_url,
  ap.data->>'project_status'              AS project_status,
  ap.data->>'project_id'                  AS external_project_id,
  op.data->>'portfolio_status'            AS portfolio_status,
  op.data->>'sales_priority'              AS sales_priority,
  (op.data->>'show_on_website')::boolean  AS show_on_website,
  op.created_at                           AS scoped_since
FROM public.unified_records op
JOIN public.unified_records ap
  ON ap.id = NULLIF(op.data->>'project','')::uuid
 AND ap.model_id = '220c49b9-de57-492d-9eca-c0d9f54fd40f'
LEFT JOIN public.unified_records dev
  ON dev.id = NULLIF(ap.data->>'developer','')::uuid
 AND dev.model_id = '11bade2c-7da9-4d00-b045-eaab37153da2'
WHERE op.model_id = '6609286a-f95a-45db-94e6-48cfa915ccbd';

GRANT SELECT ON public.v_our_projects_scope TO service_role, authenticated;

-- ── Per-project coverage inventory ──────────────────────────────────────────
-- Every scoped project gets a row, INCLUDING zero-coverage ones. A project with
-- no discovered accounts must be visible as "researched, nothing found" rather
-- than silently absent — the previous audit showed absence being read as zero.
CREATE TABLE IF NOT EXISTS public.mkt_project_coverage (
  project_id            uuid PRIMARY KEY,
  developer_org_id      uuid REFERENCES public.mkt_organizations(id) ON DELETE SET NULL,
  developer_resolved    boolean NOT NULL DEFAULT false,
  developer_evidence    jsonb   NOT NULL DEFAULT '{}'::jsonb,
  project_aliases       text[]  NOT NULL DEFAULT '{}',
  developer_aliases     text[]  NOT NULL DEFAULT '{}',
  platforms_researched  text[]  NOT NULL DEFAULT '{}',
  accounts_found        integer NOT NULL DEFAULT 0,
  accounts_configured   integer NOT NULL DEFAULT 0,
  marketers_found       integer NOT NULL DEFAULT 0,
  coverage_state        text    NOT NULL DEFAULT 'not_researched'
    CHECK (coverage_state IN ('not_researched','research_in_progress','accounts_not_found',
                              'accounts_configured','backfill_in_progress','monitoring_active',
                              'partial_coverage','sufficient_coverage','blocked','manual_review')),
  coverage_limitations  text,
  last_audited_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_project_coverage_state_idx ON public.mkt_project_coverage(coverage_state);

-- ── Explicit per-organization, per-platform research state ──────────────────
-- A MISSING ROW MUST NEVER MEAN "no account exists". This table exists so that
-- "we looked and found nothing" is distinguishable from "nobody ever looked" —
-- the single largest blind spot in the previous audit (185 organizations sat in
-- an indeterminate state because absence carried no meaning).
CREATE TABLE IF NOT EXISTS public.mkt_org_platform_research (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.mkt_organizations(id) ON DELETE CASCADE,
  platform          text NOT NULL,
  state             text NOT NULL
    CHECK (state IN ('found_configured','found_not_relevant','found_duplicate','found_private',
                     'found_inaccessible','not_found','search_failed','manual_review',
                     'platform_unsupported','not_applicable','not_researched')),
  account_id        uuid REFERENCES public.mkt_social_accounts(id) ON DELETE SET NULL,
  candidate_url     text,
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence        numeric,
  researched_at     timestamptz,
  researched_by     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, platform)
);
CREATE INDEX IF NOT EXISTS mkt_org_platform_research_state_idx ON public.mkt_org_platform_research(state);

ALTER TABLE public.mkt_project_coverage      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_org_platform_research ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mkt_project_coverage_read ON public.mkt_project_coverage;
CREATE POLICY mkt_project_coverage_read ON public.mkt_project_coverage
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS mkt_org_platform_research_read ON public.mkt_org_platform_research;
CREATE POLICY mkt_org_platform_research_read ON public.mkt_org_platform_research
  FOR SELECT TO authenticated USING (true);

-- ── Scope guard: is this organization relevant to OUR_PROJECTS? ─────────────
-- Used before enqueueing any scoped collection so a job can never fan out to an
-- unrelated organization. Relevance = an active link to at least one project in
-- the scope view.
CREATE OR REPLACE FUNCTION public.mkt_org_in_our_projects_scope(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.mkt_project_organizations po
    JOIN public.v_our_projects_scope s ON s.project_id = po.project_id
    WHERE po.organization_id = p_org AND po.is_active
  );
$$;
GRANT EXECUTE ON FUNCTION public.mkt_org_in_our_projects_scope(uuid) TO service_role, authenticated;

-- Seed one coverage row per scoped project (idempotent; zero-coverage included).
INSERT INTO public.mkt_project_coverage (project_id)
SELECT s.project_id FROM public.v_our_projects_scope s
ON CONFLICT (project_id) DO NOTHING;;

-- ── applied as 20260727102859 — "mkt_refresh_our_projects_coverage" ──────────────────────────────
-- Refresh the OUR_PROJECTS coverage inventory. Every scoped project gets a row,
-- including zero-coverage ones — absence must never be silently readable as zero.
-- Idempotent; safe to run after any collection or attribution change.
CREATE OR REPLACE FUNCTION public.mkt_refresh_our_projects_coverage()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_n integer;
BEGIN
  INSERT INTO public.mkt_project_coverage (project_id)
  SELECT s.project_id FROM public.v_our_projects_scope s
  ON CONFLICT (project_id) DO NOTHING;

  WITH s AS (SELECT * FROM public.v_our_projects_scope),
  dev AS (
    SELECT s.project_id,
           (SELECT po.organization_id FROM public.mkt_project_organizations po
             WHERE po.project_id = s.project_id AND po.is_active
               AND po.relationship_type = 'developer' LIMIT 1) AS dev_org
    FROM s
  ),
  agg AS (
    SELECT s.project_id,
      (SELECT count(*) FROM public.mkt_project_organizations po
        WHERE po.project_id=s.project_id AND po.is_active
          AND po.relationship_type <> 'developer')                          AS marketers,
      (SELECT count(DISTINCT a2.id) FROM public.mkt_social_accounts a2
         JOIN public.mkt_project_organizations po2 ON po2.organization_id=a2.organization_id
        WHERE po2.project_id=s.project_id AND po2.is_active)                AS accounts_cfg,
      (SELECT count(*) FROM public.mkt_content_attributions ca
        WHERE ca.project_id=s.project_id
          AND ca.review_status IN ('auto_accepted','confirmed'))            AS confirmed,
      (SELECT COALESCE(array_agg(DISTINCT a3.platform), '{}')
         FROM public.mkt_social_accounts a3
         JOIN public.mkt_project_organizations po3 ON po3.organization_id=a3.organization_id
        WHERE po3.project_id=s.project_id AND po3.is_active)                AS platforms
    FROM s
  )
  UPDATE public.mkt_project_coverage c
  SET developer_org_id     = dev.dev_org,
      developer_resolved   = dev.dev_org IS NOT NULL,
      marketers_found      = agg.marketers,
      accounts_configured  = agg.accounts_cfg,
      accounts_found       = agg.accounts_cfg,
      platforms_researched = agg.platforms,
      project_aliases      = ARRAY[COALESCE(s.project_name_ar,'')]::text[],
      coverage_state = CASE
        WHEN agg.accounts_cfg = 0 AND dev.dev_org IS NULL THEN 'not_researched'
        WHEN agg.accounts_cfg = 0                          THEN 'accounts_not_found'
        WHEN agg.confirmed >= 20                           THEN 'sufficient_coverage'
        WHEN agg.confirmed > 0                             THEN 'partial_coverage'
        ELSE 'accounts_configured'
      END,
      coverage_limitations = CASE
        WHEN agg.accounts_cfg = 0 THEN 'no social account configured for any linked organization'
        WHEN agg.confirmed = 0    THEN 'accounts collected but no content attributed to this project yet'
        WHEN agg.confirmed < 20   THEN 'below the 20-confirmed-record sufficiency bar'
        ELSE NULL END,
      last_audited_at = now(),
      updated_at      = now()
  FROM s, dev, agg
  WHERE c.project_id = s.project_id AND dev.project_id = s.project_id AND agg.project_id = s.project_id;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $fn$;

GRANT EXECUTE ON FUNCTION public.mkt_refresh_our_projects_coverage() TO service_role, authenticated;;

