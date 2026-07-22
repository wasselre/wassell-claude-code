-- ============================================================================
-- Paid Advertising Intelligence — production hardening.
--
-- Turns the Meta Ad Library pilot into a durable competitor-intelligence layer:
--   1. Advertiser identity on the organization  — page-based (not keyword)
--      recurring collection. Keyword search is DISCOVERY ONLY.
--   2. Permanent creative storage + deterministic fingerprint (sha256) +
--      perceptual hash (dHash, optional) columns on mkt_paid_ads.
--   3. Campaign grouping (mkt_ad_campaigns) by advertiser + landing + CTA +
--      headline-key signature.
--   4. Normalized landing pages (mkt_landing_pages) — tracking-param stripped
--      canonical URL is the dedup key.
--   5. Deterministic intelligence (mkt_insights) + a notification engine that
--      GENERATES events but does NOT send (mkt_notifications, status='pending').
--   6. Extended mkt_ad_history change_type vocabulary for campaign lifecycle.
--
-- All writes go through SECURITY DEFINER RPCs (service-role, from the worker /
-- API). Reads are open to authenticated users (competitor intel is shared,
-- non-sensitive). This file mirrors the state applied live on wassell-prod;
-- every statement is guarded so it is safe to re-run.
-- ============================================================================

BEGIN;

-- ── 1. Advertiser identity on the organization ──────────────────────────────
ALTER TABLE public.mkt_organizations
  ADD COLUMN IF NOT EXISTS meta_page_id       text,
  ADD COLUMN IF NOT EXISTS meta_advertiser_id text,
  ADD COLUMN IF NOT EXISTS meta_page_url      text,
  ADD COLUMN IF NOT EXISTS meta_display_name  text,
  ADD COLUMN IF NOT EXISTS meta_verification  jsonb,
  ADD COLUMN IF NOT EXISTS meta_confirmed     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS meta_candidates    jsonb;

-- ── 2. Intel columns on the ad ──────────────────────────────────────────────
ALTER TABLE public.mkt_paid_ads
  ADD COLUMN IF NOT EXISTS creative_stored_url   text,   -- permanent (our storage)
  ADD COLUMN IF NOT EXISTS creative_original_url text,   -- Meta CDN URL (metadata only; expires)
  ADD COLUMN IF NOT EXISTS creative_fingerprint  text,   -- sha256 of the bytes (exact dup / reuse)
  ADD COLUMN IF NOT EXISTS creative_phash        text,   -- perceptual dHash (resize-robust; optional)
  ADD COLUMN IF NOT EXISTS campaign_id           uuid,
  ADD COLUMN IF NOT EXISTS landing_page_id       uuid;
CREATE INDEX IF NOT EXISTS mkt_paid_ads_fingerprint_idx ON public.mkt_paid_ads (creative_fingerprint);
CREATE INDEX IF NOT EXISTS mkt_paid_ads_phash_idx       ON public.mkt_paid_ads (creative_phash);
CREATE INDEX IF NOT EXISTS mkt_paid_ads_campaign_idx    ON public.mkt_paid_ads (campaign_id);

-- ── 3. Campaigns ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_ad_campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform         text NOT NULL DEFAULT 'meta',
  organization_id  uuid,
  advertiser_name  text,
  signature        text NOT NULL,     -- deterministic; org|advertiser|landing|cta|headline-key
  primary_cta      text,
  primary_headline text,
  landing_page_id  uuid,
  ad_count         int  NOT NULL DEFAULT 0,
  active_ad_count  int  NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_ad_campaigns_sig_uidx ON public.mkt_ad_campaigns (platform, signature);

-- ── 4. Landing pages (normalized) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_landing_pages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_url      text NOT NULL,   -- tracking-param stripped; the dedup key
  destination_domain text,
  project_id         uuid,
  organization_id    uuid,
  ad_count           int NOT NULL DEFAULT 0,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_landing_pages_canon_uidx ON public.mkt_landing_pages (canonical_url);
CREATE INDEX IF NOT EXISTS mkt_landing_pages_domain_idx ON public.mkt_landing_pages (destination_domain);

-- ── 5. Insights (deterministic; NO AI yet) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_insights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,   -- new_campaign | new_creative | creative_reused | campaign_ended | new_landing_page | creative_burst | ...
  severity        text NOT NULL DEFAULT 'info',  -- info | opportunity | warning
  organization_id uuid,
  project_id      uuid,
  campaign_id     uuid,
  title           text NOT NULL,
  body            text,
  evidence        jsonb,
  dedup_key       text NOT NULL,   -- idempotency (ON CONFLICT DO NOTHING)
  generated_at    timestamptz NOT NULL DEFAULT now(),
  dismissed       boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_insights_dedup_uidx ON public.mkt_insights (dedup_key);
CREATE INDEX IF NOT EXISTS mkt_insights_proj_idx ON public.mkt_insights (project_id, generated_at DESC);

-- ── 6. Notifications (generated but NOT sent) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.mkt_notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_id      uuid,
  kind            text NOT NULL,
  organization_id uuid,
  project_id      uuid,
  payload         jsonb,
  dedup_key       text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',  -- pending | sent | suppressed
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mkt_notifications_dedup_uidx ON public.mkt_notifications (dedup_key);

-- ── 7. Campaign column + extended change vocabulary on history ──────────────
ALTER TABLE public.mkt_ad_history ADD COLUMN IF NOT EXISTS campaign_id uuid;
ALTER TABLE public.mkt_ad_history DROP CONSTRAINT IF EXISTS mkt_ad_history_change_type_check;
ALTER TABLE public.mkt_ad_history ADD CONSTRAINT mkt_ad_history_change_type_check
  CHECK (change_type = ANY (ARRAY[
    'new','removed','creative_change','cta_change','landing_change','status_change','text_change',
    'campaign_launched','campaign_paused','campaign_resumed','campaign_ended'
  ]));

-- ── 8. RLS — reads open to authenticated (shared competitor intel); writes only via SECURITY DEFINER RPCs ──
ALTER TABLE public.mkt_ad_campaigns  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_landing_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_insights      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mkt_ad_campaigns_read  ON public.mkt_ad_campaigns;
DROP POLICY IF EXISTS mkt_landing_pages_read ON public.mkt_landing_pages;
DROP POLICY IF EXISTS mkt_insights_read      ON public.mkt_insights;
DROP POLICY IF EXISTS mkt_notifications_read ON public.mkt_notifications;
CREATE POLICY mkt_ad_campaigns_read  ON public.mkt_ad_campaigns  FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_landing_pages_read ON public.mkt_landing_pages FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_insights_read      ON public.mkt_insights      FOR SELECT TO authenticated USING (true);
CREATE POLICY mkt_notifications_read ON public.mkt_notifications FOR SELECT TO authenticated USING (true);

-- ── 9. RPCs (service-role; SECURITY DEFINER) ────────────────────────────────

-- Confirm / store the advertiser identity for an organization.
CREATE OR REPLACE FUNCTION public.mkt_org_set_advertiser(
  p_org uuid, p_page_id text, p_advertiser_id text, p_page_url text, p_display_name text,
  p_verification jsonb DEFAULT NULL, p_confirmed boolean DEFAULT true, p_candidates jsonb DEFAULT NULL)
 RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $function$
  UPDATE public.mkt_organizations SET
    meta_page_id=COALESCE(p_page_id, meta_page_id), meta_advertiser_id=COALESCE(p_advertiser_id, meta_advertiser_id),
    meta_page_url=COALESCE(p_page_url, meta_page_url), meta_display_name=COALESCE(p_display_name, meta_display_name),
    meta_verification=COALESCE(p_verification, meta_verification), meta_confirmed=p_confirmed,
    meta_candidates=CASE WHEN p_candidates IS NOT NULL THEN p_candidates ELSE meta_candidates END, updated_at=now()
  WHERE id=p_org;
$function$;

-- Upsert a normalized landing page; returns its id.
CREATE OR REPLACE FUNCTION public.mkt_landing_upsert(
  p_canonical_url text, p_destination_domain text, p_project_id uuid DEFAULT NULL, p_organization_id uuid DEFAULT NULL)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.mkt_landing_pages (canonical_url, destination_domain, project_id, organization_id)
  VALUES (p_canonical_url, p_destination_domain, p_project_id, p_organization_id)
  ON CONFLICT (canonical_url) DO UPDATE SET last_seen_at=now(),
    project_id=COALESCE(mkt_landing_pages.project_id, EXCLUDED.project_id),
    organization_id=COALESCE(mkt_landing_pages.organization_id, EXCLUDED.organization_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

-- Upsert a campaign by (platform, signature); returns (id, was_inserted).
-- NOTE: the UPDATE branch qualifies every column with the table alias `c` —
-- an unqualified `id` collides with the RETURNS TABLE(id ...) OUT variable and
-- raises "column reference id is ambiguous" on the conflict path.
CREATE OR REPLACE FUNCTION public.mkt_campaign_upsert(
  p_signature text, p_organization_id uuid, p_advertiser_name text,
  p_landing_page_id uuid DEFAULT NULL, p_cta text DEFAULT NULL, p_headline text DEFAULT NULL, p_run_id uuid DEFAULT NULL)
 RETURNS TABLE(id uuid, was_inserted boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid; v_new boolean := false;
BEGIN
  SELECT c.id INTO v_id FROM public.mkt_ad_campaigns c WHERE c.platform='meta' AND c.signature=p_signature;
  IF v_id IS NULL THEN
    INSERT INTO public.mkt_ad_campaigns (platform, signature, organization_id, advertiser_name, landing_page_id, primary_cta, primary_headline)
    VALUES ('meta', p_signature, p_organization_id, p_advertiser_name, p_landing_page_id, p_cta, p_headline)
    RETURNING mkt_ad_campaigns.id INTO v_id;
    v_new := true;
  ELSE
    UPDATE public.mkt_ad_campaigns c SET last_seen_at=now(), updated_at=now(),
      advertiser_name=COALESCE(c.advertiser_name, p_advertiser_name),
      primary_cta=COALESCE(c.primary_cta, p_cta),
      primary_headline=COALESCE(c.primary_headline, p_headline),
      landing_page_id=COALESCE(c.landing_page_id, p_landing_page_id)
    WHERE c.id=v_id;
  END IF;
  RETURN QUERY SELECT v_id, v_new;
END $function$;

-- Recompute a campaign's rollups from its ads; ends it when nothing is active.
CREATE OR REPLACE FUNCTION public.mkt_campaign_refresh(p_campaign uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_total int; v_active int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE is_active) INTO v_total, v_active FROM public.mkt_paid_ads WHERE campaign_id=p_campaign;
  UPDATE public.mkt_ad_campaigns SET ad_count=v_total, active_ad_count=v_active,
    is_active=(v_active>0), ended_at=CASE WHEN v_active=0 AND ended_at IS NULL THEN now() ELSE ended_at END,
    updated_at=now() WHERE id=p_campaign;
END $function$;

-- Emit an insight idempotently; returns id, or NULL when it already existed.
CREATE OR REPLACE FUNCTION public.mkt_insight_emit(
  p_kind text, p_dedup_key text, p_title text, p_body text DEFAULT NULL, p_severity text DEFAULT 'info',
  p_organization_id uuid DEFAULT NULL, p_project_id uuid DEFAULT NULL, p_campaign_id uuid DEFAULT NULL,
  p_evidence jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.mkt_insights (kind, dedup_key, title, body, severity, organization_id, project_id, campaign_id, evidence)
  VALUES (p_kind, p_dedup_key, p_title, p_body, p_severity, p_organization_id, p_project_id, p_campaign_id, COALESCE(p_evidence,'{}'::jsonb))
  ON CONFLICT (dedup_key) DO NOTHING RETURNING id INTO v_id;
  RETURN v_id;  -- NULL when it already existed (idempotent)
END $function$;

-- Emit a notification event idempotently (status='pending' — NOT sent).
CREATE OR REPLACE FUNCTION public.mkt_notification_emit(
  p_insight_id uuid, p_kind text, p_dedup_key text,
  p_organization_id uuid DEFAULT NULL, p_project_id uuid DEFAULT NULL, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.mkt_notifications (insight_id, kind, dedup_key, organization_id, project_id, payload)
  VALUES (p_insight_id, p_kind, p_dedup_key, p_organization_id, p_project_id, COALESCE(p_payload,'{}'::jsonb))
  ON CONFLICT (dedup_key) DO NOTHING RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

COMMIT;
