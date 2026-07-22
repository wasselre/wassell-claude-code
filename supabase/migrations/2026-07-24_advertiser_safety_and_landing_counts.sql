-- ============================================================================
-- Advertiser safety constraints + landing-page ad-count maintenance + audit.
--
-- Post-deployment validation found Bayut's ads mis-attributed to Almajdiah
-- (a single/first keyword hit was auto-confirmed). Deterministic candidate
-- scoring (worker/src/marketing/advertiserScoring.ts) now gates auto-confirm;
-- this migration adds the DB-level defenses:
--   * paid_ads collection is BLOCKED for an org without a confirmed advertiser
--     page (defense in depth beyond the worker check).
--   * a confirmed advertiser MUST carry a Meta Page ID.
--   * discovery/candidate stores can never silently clear a confirmed identity.
--   * changing a confirmed Page ID writes an audit event.
--   * mkt_landing_pages.ad_count is now maintained by a trigger (was always 0).
-- ============================================================================

BEGIN;

-- ── advertiser identity columns ─────────────────────────────────────────────
ALTER TABLE public.mkt_organizations
  ADD COLUMN IF NOT EXISTS meta_confirmed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS meta_discovery_confidence text,
  ADD COLUMN IF NOT EXISTS meta_confirmation_evidence jsonb;

-- ── audit trail for advertiser identity changes ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_advertiser_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  event           text NOT NULL,   -- confirmed | unconfirmed | page_id_changed
  old_page_id     text,
  new_page_id     text,
  actor           text,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mkt_advertiser_audit_org_idx ON public.mkt_advertiser_audit (organization_id, created_at DESC);
ALTER TABLE public.mkt_advertiser_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_advertiser_audit_read ON public.mkt_advertiser_audit;
CREATE POLICY mkt_advertiser_audit_read ON public.mkt_advertiser_audit FOR SELECT TO authenticated USING (true);

-- ── rewritten setter: page-id-required-on-confirm + audit + no-silent-overwrite ──
CREATE OR REPLACE FUNCTION public.mkt_org_set_advertiser(
  p_org uuid, p_page_id text, p_advertiser_id text, p_page_url text, p_display_name text,
  p_verification jsonb DEFAULT NULL, p_confirmed boolean DEFAULT true, p_candidates jsonb DEFAULT NULL)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_old_page text; v_old_confirmed boolean;
BEGIN
  SELECT meta_page_id, meta_confirmed INTO v_old_page, v_old_confirmed FROM public.mkt_organizations WHERE id=p_org;

  IF p_confirmed THEN
    IF p_page_id IS NULL OR p_page_id = '' THEN
      RAISE EXCEPTION 'a confirmed advertiser must have a Meta Page ID' USING ERRCODE='23514';
    END IF;
    IF v_old_page IS NOT NULL AND v_old_page <> p_page_id THEN
      INSERT INTO public.mkt_advertiser_audit(organization_id, event, old_page_id, new_page_id, detail)
      VALUES (p_org, 'page_id_changed', v_old_page, p_page_id, COALESCE(p_verification,'{}'::jsonb));
    END IF;
    UPDATE public.mkt_organizations SET
      meta_page_id=p_page_id, meta_advertiser_id=COALESCE(p_advertiser_id, p_page_id),
      meta_page_url=p_page_url, meta_display_name=p_display_name,
      meta_verification=p_verification, meta_confirmation_evidence=p_verification,
      meta_discovery_confidence=(p_verification->>'confidence'),
      meta_confirmed=true, meta_confirmed_at=now(),
      meta_candidates=COALESCE(p_candidates, meta_candidates), updated_at=now()
    WHERE id=p_org;
    INSERT INTO public.mkt_advertiser_audit(organization_id, event, old_page_id, new_page_id, detail)
    VALUES (p_org, 'confirmed', v_old_page, p_page_id, COALESCE(p_verification,'{}'::jsonb));
  ELSE
    -- Not confirming. If already confirmed and this is a candidates-only store
    -- (no page id), keep the confirmed identity intact — only refresh candidates.
    IF COALESCE(v_old_confirmed,false) AND (p_page_id IS NULL OR p_page_id='') THEN
      UPDATE public.mkt_organizations SET meta_candidates=COALESCE(p_candidates, meta_candidates), updated_at=now() WHERE id=p_org;
    ELSE
      IF COALESCE(v_old_confirmed,false) THEN
        INSERT INTO public.mkt_advertiser_audit(organization_id, event, old_page_id, new_page_id, detail)
        VALUES (p_org, 'unconfirmed', v_old_page, NULL, COALESCE(p_verification,'{}'::jsonb));
      END IF;
      UPDATE public.mkt_organizations SET
        meta_page_id=p_page_id, meta_advertiser_id=p_advertiser_id, meta_page_url=p_page_url,
        meta_display_name=p_display_name, meta_verification=p_verification,
        meta_confirmed=false, meta_confirmed_at=NULL,
        meta_candidates=COALESCE(p_candidates, meta_candidates), updated_at=now()
      WHERE id=p_org;
    END IF;
  END IF;
END $$;

-- ── block paid_ads enqueue for an org without a confirmed advertiser page ────
CREATE OR REPLACE FUNCTION public.mkt_job_enqueue(
  p_kind text, p_provider text, p_social_account_id uuid, p_params jsonb DEFAULT '{}'::jsonb,
  p_priority integer DEFAULT 100, p_requested_by uuid DEFAULT NULL, p_fallback_of uuid DEFAULT NULL)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid; v_max int; v_org uuid; v_conf boolean; v_page text;
BEGIN
  IF p_kind = 'paid_ads' THEN
    v_org := NULLIF(p_params->>'organization_id','')::uuid;
    IF v_org IS NULL THEN RAISE EXCEPTION 'paid_ads requires organization_id in params' USING ERRCODE='23514'; END IF;
    SELECT meta_confirmed, meta_page_id INTO v_conf, v_page FROM public.mkt_organizations WHERE id=v_org;
    IF NOT COALESCE(v_conf,false) OR v_page IS NULL THEN
      RAISE EXCEPTION 'paid_ads blocked: organization % has no confirmed advertiser page', v_org USING ERRCODE='23514';
    END IF;
  END IF;

  -- account-scoped dedup: never queue two of the same kind for one account
  IF p_social_account_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.mkt_collection_jobs
     WHERE social_account_id = p_social_account_id AND kind = p_kind AND status IN ('pending','queued','running') LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  -- org-scoped dedup for account-less kinds (discover_advertiser, paid_ads):
  -- a double-click/retry returns the in-flight job instead of a duplicate Apify run.
  ELSIF p_kind IN ('discover_advertiser','paid_ads') AND NULLIF(p_params->>'organization_id','') IS NOT NULL THEN
    SELECT id INTO v_id FROM public.mkt_collection_jobs
     WHERE kind = p_kind AND status IN ('pending','queued','running')
       AND params->>'organization_id' = (p_params->>'organization_id') LIMIT 1;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  END IF;
  SELECT COALESCE((SELECT (value)::int FROM public.mkt_settings WHERE key='max_attempts'),5) INTO v_max;
  INSERT INTO public.mkt_collection_jobs (kind, provider, social_account_id, params, priority, max_attempts, requested_by, fallback_of)
  VALUES (p_kind, p_provider, p_social_account_id, COALESCE(p_params,'{}'::jsonb), p_priority, v_max, p_requested_by, p_fallback_of)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ── maintain mkt_landing_pages.ad_count via trigger (was always 0) ──────────
CREATE OR REPLACE FUNCTION public.mkt_landing_recount() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.landing_page_id IS NOT NULL THEN
    UPDATE public.mkt_landing_pages SET ad_count=(SELECT count(*) FROM public.mkt_paid_ads WHERE landing_page_id=OLD.landing_page_id) WHERE id=OLD.landing_page_id;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.landing_page_id IS NOT NULL THEN
    UPDATE public.mkt_landing_pages SET ad_count=(SELECT count(*) FROM public.mkt_paid_ads WHERE landing_page_id=NEW.landing_page_id) WHERE id=NEW.landing_page_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS mkt_paid_ads_landing_recount ON public.mkt_paid_ads;
CREATE TRIGGER mkt_paid_ads_landing_recount
  AFTER INSERT OR DELETE OR UPDATE OF landing_page_id ON public.mkt_paid_ads
  FOR EACH ROW EXECUTE FUNCTION public.mkt_landing_recount();
-- backfill existing counts (idempotent)
UPDATE public.mkt_landing_pages lp SET ad_count = (SELECT count(*) FROM public.mkt_paid_ads pa WHERE pa.landing_page_id = lp.id);

COMMIT;