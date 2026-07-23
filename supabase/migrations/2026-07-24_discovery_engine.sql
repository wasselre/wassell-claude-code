-- ============================================================================
-- Automated identity-discovery engine.
--
-- Replaces the manual "Claude drives Chrome + keyword search" method with a
-- queued, Browserbase-backed, evidence-storing, deterministically-scored
-- pipeline. Every account candidate carries its full evidence trail (which
-- query/source/URL produced it) and a reproducible score; auto-confirm requires
-- strong independent evidence (site↔account link-back or official-domain match),
-- never a name or a top search result alone.
--
--   mkt_discovery_runs      — one run per org (status, sources, stats, cost)
--   mkt_discovery_queries   — every query executed (source, text, result count)
--   mkt_discovery_evidence  — every URL/link/tag found, with extracted data
--   mkt_identity_candidates — resolved per-platform accounts + score + status
--
-- Confirmed candidates flow into mkt_social_accounts (existing). The identity
-- graph = organizations (existing) → identity_candidates (accounts, with class)
-- → social_accounts (confirmed) + mkt_project_organizations (developer/marketer
-- edges) + all_projects (projects). No competing generic entity/edge model.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.mkt_discovery_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL,
  status           text NOT NULL DEFAULT 'running',   -- running | done | failed
  trigger          text,                              -- manual | scheduled | reverify
  sources_used     text[] NOT NULL DEFAULT '{}',
  queries_count    int NOT NULL DEFAULT 0,
  evidence_count   int NOT NULL DEFAULT 0,
  candidates_count int NOT NULL DEFAULT 0,
  confirmed_count  int NOT NULL DEFAULT 0,
  cost_usd         numeric NOT NULL DEFAULT 0,
  error            text,
  summary          jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_discovery_runs_org_idx ON public.mkt_discovery_runs (organization_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.mkt_discovery_queries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL,
  organization_id  uuid NOT NULL,
  source           text NOT NULL,   -- site_crawl | google | instagram | tiktok | youtube | facebook | crosslink
  query            text NOT NULL,
  result_count     int NOT NULL DEFAULT 0,
  executed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_discovery_queries_run_idx ON public.mkt_discovery_queries (run_id);

CREATE TABLE IF NOT EXISTS public.mkt_discovery_evidence (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id           uuid NOT NULL,
  organization_id  uuid NOT NULL,
  source           text NOT NULL,   -- site_crawl | google | crosslink | jsonld | og | sitemap
  kind             text NOT NULL,   -- social_link | search_result | jsonld_sameas | og_url | crosslink | site_page | link_in_bio
  platform         text,            -- instagram | tiktok | youtube | facebook | x | linkedin | snapchat | domain
  handle           text,
  url              text,
  title            text,
  snippet          text,
  extracted        jsonb NOT NULL DEFAULT '{}'::jsonb,
  screenshot_ref   text,
  collected_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_discovery_evidence_run_idx ON public.mkt_discovery_evidence (run_id);
CREATE INDEX IF NOT EXISTS mkt_discovery_evidence_org_platform_idx ON public.mkt_discovery_evidence (organization_id, platform);

CREATE TABLE IF NOT EXISTS public.mkt_identity_candidates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL,
  platform           text NOT NULL,   -- instagram | tiktok | youtube | facebook | x | linkedin | snapchat | website
  handle             text NOT NULL,
  account_id         text,            -- stable platform id where resolved (page id / channel id)
  url                text,
  account_class      text NOT NULL DEFAULT 'unknown', -- organization | brand | project | marketer | marketplace | broker | unknown
  score              numeric NOT NULL DEFAULT 0,
  confidence         text NOT NULL DEFAULT 'low',     -- high | medium | low
  is_marketplace     boolean NOT NULL DEFAULT false,
  reasons            jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence           jsonb NOT NULL DEFAULT '[]'::jsonb,
  status             text NOT NULL DEFAULT 'candidate', -- candidate | confirmed | rejected | stale
  rejection_reason   text,
  verification_method text,
  discovery_run_id   uuid,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_verified_at   timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_identity_candidates_uq ON public.mkt_identity_candidates (organization_id, platform, handle);
CREATE INDEX IF NOT EXISTS mkt_identity_candidates_status_idx ON public.mkt_identity_candidates (organization_id, status);

-- RLS: authenticated read (admin-gated at the page level); writes via SECURITY DEFINER RPCs.
ALTER TABLE public.mkt_discovery_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_discovery_queries   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_discovery_evidence  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_identity_candidates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_discovery_runs_read      ON public.mkt_discovery_runs;
DROP POLICY IF EXISTS mkt_discovery_queries_read   ON public.mkt_discovery_queries;
DROP POLICY IF EXISTS mkt_discovery_evidence_read  ON public.mkt_discovery_evidence;
DROP POLICY IF EXISTS mkt_identity_candidates_read ON public.mkt_identity_candidates;
CREATE POLICY mkt_discovery_runs_read      ON public.mkt_discovery_runs      FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_discovery_queries_read   ON public.mkt_discovery_queries   FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_discovery_evidence_read  ON public.mkt_discovery_evidence  FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_identity_candidates_read ON public.mkt_identity_candidates FOR SELECT TO authenticated USING (true);

-- ── RPCs (service-role; SECURITY DEFINER) ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.mkt_discovery_run_start(p_org uuid, p_trigger text DEFAULT 'manual')
 RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  INSERT INTO public.mkt_discovery_runs (organization_id, trigger) VALUES (p_org, p_trigger) RETURNING id;
$$;

CREATE OR REPLACE FUNCTION public.mkt_discovery_run_finish(
  p_run uuid, p_status text, p_sources text[], p_queries int, p_evidence int,
  p_candidates int, p_confirmed int, p_cost numeric, p_summary jsonb DEFAULT '{}'::jsonb, p_error text DEFAULT NULL)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  UPDATE public.mkt_discovery_runs SET
    status=p_status, sources_used=COALESCE(p_sources,'{}'), queries_count=p_queries, evidence_count=p_evidence,
    candidates_count=p_candidates, confirmed_count=p_confirmed, cost_usd=p_cost,
    summary=COALESCE(p_summary,'{}'::jsonb), error=p_error, finished_at=now()
  WHERE id=p_run;
$$;

CREATE OR REPLACE FUNCTION public.mkt_discovery_query_log(
  p_run uuid, p_org uuid, p_source text, p_query text, p_results int)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  INSERT INTO public.mkt_discovery_queries (run_id, organization_id, source, query, result_count)
  VALUES (p_run, p_org, p_source, p_query, COALESCE(p_results,0));
$$;

CREATE OR REPLACE FUNCTION public.mkt_discovery_evidence_add(
  p_run uuid, p_org uuid, p_source text, p_kind text, p_platform text, p_handle text,
  p_url text, p_title text, p_snippet text, p_extracted jsonb DEFAULT '{}'::jsonb, p_screenshot text DEFAULT NULL)
 RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $$
  INSERT INTO public.mkt_discovery_evidence (run_id, organization_id, source, kind, platform, handle, url, title, snippet, extracted, screenshot_ref)
  VALUES (p_run, p_org, p_source, p_kind, p_platform, p_handle, p_url, p_title, p_snippet, COALESCE(p_extracted,'{}'::jsonb), p_screenshot)
  RETURNING id;
$$;

-- Upsert a scored candidate. Never downgrades a human-confirmed/rejected status.
CREATE OR REPLACE FUNCTION public.mkt_identity_candidate_upsert(
  p_org uuid, p_platform text, p_handle text, p_account_id text, p_url text, p_class text,
  p_score numeric, p_confidence text, p_is_marketplace boolean, p_reasons jsonb, p_evidence jsonb,
  p_status text, p_verification_method text, p_run uuid)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid; v_existing text;
BEGIN
  SELECT id, status INTO v_id, v_existing FROM public.mkt_identity_candidates
   WHERE organization_id=p_org AND platform=p_platform AND handle=p_handle;
  IF v_id IS NULL THEN
    INSERT INTO public.mkt_identity_candidates
      (organization_id, platform, handle, account_id, url, account_class, score, confidence, is_marketplace,
       reasons, evidence, status, verification_method, discovery_run_id)
    VALUES (p_org, p_platform, p_handle, p_account_id, p_url, COALESCE(p_class,'unknown'), p_score, p_confidence,
            COALESCE(p_is_marketplace,false), COALESCE(p_reasons,'[]'::jsonb), COALESCE(p_evidence,'[]'::jsonb),
            COALESCE(p_status,'candidate'), p_verification_method, p_run)
    RETURNING id INTO v_id;
  ELSE
    -- refresh score/evidence; preserve a human decision (confirmed/rejected) unless the caller explicitly confirms.
    UPDATE public.mkt_identity_candidates SET
      account_id=COALESCE(p_account_id, account_id), url=COALESCE(p_url, url), account_class=COALESCE(p_class, account_class),
      score=p_score, confidence=p_confidence, is_marketplace=COALESCE(p_is_marketplace,false),
      reasons=COALESCE(p_reasons, reasons), evidence=COALESCE(p_evidence, evidence),
      status=CASE WHEN status IN ('confirmed','rejected') AND p_status NOT IN ('confirmed','rejected') THEN status ELSE COALESCE(p_status, status) END,
      verification_method=COALESCE(p_verification_method, verification_method),
      discovery_run_id=COALESCE(p_run, discovery_run_id), last_verified_at=now(), updated_at=now()
    WHERE id=v_id;
  END IF;
  RETURN v_id;
END $$;

-- allow the discovery job kinds
ALTER TABLE public.mkt_collection_jobs DROP CONSTRAINT IF EXISTS mkt_collection_jobs_kind_check;
ALTER TABLE public.mkt_collection_jobs ADD CONSTRAINT mkt_collection_jobs_kind_check
  CHECK (kind = ANY (ARRAY['discover','discover_advertiser','organization_discovery','account_verification',
    'backfill','incremental','post_metrics','account_metrics','paid_ads','attribution','reprocess']));

COMMIT;